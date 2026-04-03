require("dotenv").config();
const express = require("express");
const simpleGit = require("simple-git");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const mime = require("mime-types");

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err.message);
  console.error(err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled Rejection:", reason);
});

const app = express();
app.use(express.json());
const cors = require("cors");
app.use(cors());

const OUTPUT_DIR = path.join(__dirname, "output");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const WORKER_BASE_URL = process.env.WORKER_BASE_URL;

const DOMAIN_BASE = process.env.DOMAIN_BASE || "shreyanshu.online";

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use("/output", express.static(OUTPUT_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `upload_${Date.now()}_${file.originalname}`),
});
const upload = multer({ storage });

const R2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const BUCKET = process.env.R2_BUCKET;

(async () => {
  try {
    await R2.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1 }));
    console.log("✅ R2 connection OK — bucket:", BUCKET);
  } catch (err) {
    console.error("❌ R2 CONNECTION FAILED:", err.message);
  }
})();

const extractZip = (zipPath, extractTo) => {
  fs.mkdirSync(extractTo, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractTo, true);
  console.log(`✅ Extracted to: ${extractTo}`);
};

const deleteFolder = (folderPath) => {
  try {
    fs.rmSync(folderPath, { recursive: true, force: true });
    console.log(`🗑️  Deleted local folder: ${folderPath}`);
  } catch (err) {
    console.error(`⚠️  Failed to delete folder ${folderPath}: ${err.message}`);
  }
};

const deleteFile = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️  Deleted file: ${filePath}`);
    }
  } catch (err) {
    console.error(`⚠️  Failed to delete file ${filePath}: ${err.message}`);
  }
};

const getAllFiles = (dirPath, arrayOfFiles = []) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  }
  return arrayOfFiles;
};

const uploadDirToR2 = async (localDir, r2Prefix) => {
  const allFiles = getAllFiles(localDir);
  if (allFiles.length === 0) throw new Error(`No files found to upload in: ${localDir}`);

  console.log(`\n☁️  Uploading ${allFiles.length} files → bucket="${BUCKET}" prefix="${r2Prefix}/"`);

  let successCount = 0;
  const errors = [];

  for (const filePath of allFiles) {
    const relativePath = path.relative(localDir, filePath).replace(/\\/g, "/");
    const r2Key = `${r2Prefix}/${relativePath}`;
    const contentType = mime.lookup(filePath) || "application/octet-stream";

    try {
      const fileBuffer = fs.readFileSync(filePath);
      const response = await R2.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: r2Key,
          Body: fileBuffer,
          ContentType: contentType,
          ContentLength: fileBuffer.length,
        })
      );
      const status = response?.$metadata?.httpStatusCode;
      console.log(`  ✅ [${status}] ${r2Key}`);
      successCount++;
    } catch (err) {
      console.error(`  ❌ FAILED: ${r2Key} — ${err.message}`);
      errors.push({ key: r2Key, error: err.message });
    }
  }

  console.log(`\n☁️  Done: ${successCount}/${allFiles.length} uploaded`);
  if (errors.length > 0) {
    throw new Error(
      `${errors.length} file(s) failed:\n${errors.map((e) => `  ${e.key}: ${e.error}`).join("\n")}`
    );
  }
  return { success: successCount, total: allFiles.length };
};

const runCommand = (command, cwd) => {
  return new Promise((resolve, reject) => {
    const child = exec(command, { cwd });
    child.stdout.on("data", (data) => console.log(`[stdout] ${data}`));
    child.stderr.on("data", (data) => console.error(`[stderr] ${data}`));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Command failed (code ${code}): ${command}`));
      resolve();
    });
  });
};

const detectBuildDir = (basePath) => {
  for (const dir of ["build", "dist"]) {
    const candidate = path.join(basePath, dir);
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return { buildDir: candidate, buildDirName: dir };
    }
  }
  throw new Error("No build/ or dist/ with index.html found");
};

const toSubdomain = (folderName) => folderName.replace(/_/g, "-");

const buildSiteUrl = (folderName) => {
  const subdomain = toSubdomain(folderName);
  return `https://${subdomain}.${DOMAIN_BASE}`;
};

// ============================================================
// 🚀 ROUTE: Clone GitHub repo → build → upload to R2
// ============================================================
app.post("/clone", async (req, res) => {
  const { repoUrl } = req.body;

  if (!repoUrl) return res.status(400).json({ error: "repoUrl is required" });
  if (!repoUrl.startsWith("https://github.com/")) {
    return res.status(400).json({ error: "Only GitHub URLs allowed" });
  }

  const folderName = `repo-${Date.now()}`;
  const repoPath = path.join(OUTPUT_DIR, folderName);

  try {
    console.log("🔽 Cloning repo...");
    fs.mkdirSync(repoPath, { recursive: true });
    await simpleGit(OUTPUT_DIR).clone(repoUrl, repoPath);

    const clonedFiles = fs.readdirSync(repoPath);
    if (clonedFiles.length === 0) throw new Error("Clone succeeded but directory is empty");
    console.log("📁 Cloned files:", clonedFiles);

    console.log("📦 Installing dependencies...");
    await runCommand("npm install", repoPath);

    console.log("🏗️  Building project...");
    await runCommand("npm run build", repoPath);

    const { buildDir, buildDirName } = detectBuildDir(repoPath);

    const r2Prefix = `output/${folderName}/${buildDirName}`;
    const result = await uploadDirToR2(buildDir, r2Prefix);

    const siteUrl = buildSiteUrl(folderName);
    deleteFolder(repoPath);

    return res.json({
      message: "✅ Repo cloned, built, uploaded, and cleaned up",
      r2Prefix,
      siteUrl,
      filesUploaded: result.success,
    });
  } catch (error) {
    console.error("❌ Error:", error.message);
    deleteFolder(repoPath);
    return res.status(500).json({ error: "Process failed", details: error.message });
  }
});

// ============================================================
// 🚀 ROUTE: Upload ZIP → extract → (optional build) → upload to R2
// ============================================================
app.post("/upload-zip", upload.single("file"), async (req, res) => {
  const folderName = `zip-${Date.now()}`;
  const extractPath = path.join(UPLOAD_DIR, folderName);

  // Track the raw uploaded zip path early so catch can always clean it up
  const rawZipPath = req.file?.path ?? null;

  try {
    console.log("📥 req.file:", req.file);

    if (!req.file) {
      return res.status(400).json({
        error: "No file received.",
        hint: "In Postman: Body → form-data → key='file' → change type dropdown to File → select .zip",
      });
    }

    const isZip =
      req.file.mimetype === "application/zip" ||
      req.file.mimetype === "application/x-zip-compressed" ||
      req.file.originalname.toLowerCase().endsWith(".zip");

    if (!isZip) {
      deleteFile(rawZipPath);
      return res.status(400).json({ error: "Only ZIP files are allowed" });
    }

    console.log("📦 Extracting ZIP...");
    extractZip(rawZipPath, extractPath);

    // Delete raw zip right after successful extraction
    deleteFile(rawZipPath);

    const extractedFiles = getAllFiles(extractPath);
    console.log(`📁 Extracted ${extractedFiles.length} files`);
    if (extractedFiles.length === 0) throw new Error("ZIP extracted but no files found inside");

    let workingDir = extractPath;
    const topLevel = fs.readdirSync(extractPath);
    if (topLevel.length === 1) {
      const onlyEntry = path.join(extractPath, topLevel[0]);
      if (fs.statSync(onlyEntry).isDirectory()) {
        workingDir = onlyEntry;
        console.log(`📁 Using nested folder: ${workingDir}`);
      }
    }

    const hasPackageJson = fs.existsSync(path.join(workingDir, "package.json"));

    if (hasPackageJson) {
      console.log("📦 Installing dependencies...");
      await runCommand("npm install", workingDir);

      console.log("🏗️  Building...");
      await runCommand("npm run build", workingDir);

      const { buildDir, buildDirName } = detectBuildDir(workingDir);
      const r2Prefix = `output/${folderName}/${buildDirName}`;
      const result = await uploadDirToR2(buildDir, r2Prefix);

      const siteUrl = buildSiteUrl(folderName);
      deleteFolder(extractPath);

      return res.json({
        message: "✅ ZIP extracted, built, uploaded, and cleaned up",
        r2Prefix,
        siteUrl,
        filesUploaded: result.success,
      });
    } else {
      // Static ZIP — no build step
      const r2Prefix = `output/${folderName}`;
      const result = await uploadDirToR2(workingDir, r2Prefix);

      const hasIndex = fs.existsSync(path.join(workingDir, "index.html"));
      const siteUrl = hasIndex ? buildSiteUrl(folderName) : null;
      deleteFolder(extractPath);

      return res.json({
        message: "✅ ZIP extracted, uploaded, and cleaned up",
        r2Prefix,
        siteUrl,
        filesUploaded: result.success,
        note: siteUrl ? undefined : "No index.html found — files uploaded but no preview URL",
      });
    }
  } catch (error) {
    console.error("❌ ZIP Error:", error.message);

    // Clean up extracted folder
    deleteFolder(extractPath);

    // Clean up raw zip in case it was never deleted (e.g. crash before extraction)
    deleteFile(rawZipPath);

    return res.status(500).json({ error: "ZIP processing failed", details: error.message });
  }
});

// ============================================================
// 📂 ROUTE: List all folders from R2 (output/ and uploads/)
// ============================================================

// List every object under a given R2 prefix (handles pagination)
const listAllR2Objects = async (prefix) => {
  const objects = [];
  let continuationToken;
  do {
    const res = await R2.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    if (res.Contents) objects.push(...res.Contents);
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
};

// Given a root prefix ("output/" or "uploads/"), group objects into
// virtual top-level folders and return summary rows.
const listR2Folders = async (rootPrefix) => {
  const objects = await listAllR2Objects(rootPrefix);

  // Group by the first path segment after rootPrefix
  // e.g.  "output/zip-123/dist/index.html"  →  key = "zip-123"
  const map = new Map();
  for (const obj of objects) {
    const relative = obj.Key.slice(rootPrefix.length); // "zip-123/dist/index.html"
    const folderName = relative.split("/")[0];
    if (!folderName) continue;

    if (!map.has(folderName)) {
      map.set(folderName, { fileCount: 0, sizeBytes: 0, lastModified: obj.LastModified });
    }
    const entry = map.get(folderName);
    entry.fileCount += 1;
    entry.sizeBytes += obj.Size || 0;
    if (obj.LastModified > entry.lastModified) entry.lastModified = obj.LastModified;
  }

  return Array.from(map.entries())
    .map(([name, stats]) => ({
      name,
      r2Prefix: `${rootPrefix}${name}`,
      siteUrl: buildSiteUrl(name),
      fileCount: stats.fileCount,
      sizeBytes: stats.sizeBytes,
      lastModified: stats.lastModified,
    }))
    .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
};

app.get("/folders", async (req, res) => {
  try {
    const [output, uploads] = await Promise.all([
      listR2Folders("output/"),
      listR2Folders("uploads/"),
    ]);
    return res.json({ output, uploads });
  } catch (err) {
    console.error("❌ /folders error:", err.message);
    return res.status(500).json({ error: "Failed to list R2 folders", details: err.message });
  }
});

// ============================================================
// 🗑️  ROUTE: Delete a folder from R2 (checks output/ and uploads/)
// ============================================================

// Delete every R2 object whose key starts with a given prefix
const deleteR2Prefix = async (prefix) => {
  const objects = await listAllR2Objects(prefix);
  if (objects.length === 0) return 0;

  // DeleteObjects accepts at most 1000 keys per call
  const chunks = [];
  for (let i = 0; i < objects.length; i += 1000) {
    chunks.push(objects.slice(i, i + 1000));
  }

  let deleted = 0;
  for (const chunk of chunks) {
    const res = await R2.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: chunk.map((o) => ({ Key: o.Key })), Quiet: true },
      })
    );
    if (res.Errors?.length) {
      throw new Error(
        res.Errors.map((e) => `${e.Key}: ${e.Message}`).join(", ")
      );
    }
    deleted += chunk.length;
  }
  return deleted;
};

app.delete("/folders/:name", async (req, res) => {
  const { name } = req.params;

  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return res.status(400).json({ error: "Invalid folder name" });
  }

  try {
    const [fromOutput, fromUploads] = await Promise.all([
      deleteR2Prefix(`output/${name}/`),
      deleteR2Prefix(`uploads/${name}/`),
    ]);

    const totalDeleted = fromOutput + fromUploads;
    if (totalDeleted === 0) {
      return res.status(404).json({ error: `No R2 objects found for "${name}"` });
    }

    console.log(`🗑️  Deleted ${totalDeleted} R2 objects for "${name}" (output: ${fromOutput}, uploads: ${fromUploads})`);
    return res.json({
      message: `✅ Deleted "${name}" from R2`,
      deletedObjects: totalDeleted,
      fromOutput,
      fromUploads,
    });
  } catch (err) {
    console.error("❌ Delete error:", err.message);
    return res.status(500).json({ error: "Failed to delete from R2", details: err.message });
  }
});

// ============================================================
// Misc routes
// ============================================================
app.get("/", (req, res) => res.send("Server is running 🚀"));

app.get("/test-r2", async (req, res) => {
  try {
    const result = await R2.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 10 }));
    return res.json({
      status: "✅ R2 connected",
      bucket: BUCKET,
      objectCount: result.KeyCount,
      objects: result.Contents?.map((o) => o.Key) ?? [],
    });
  } catch (err) {
    return res.status(500).json({
      status: "❌ R2 connection failed",
      error: err.message,
      code: err.$metadata?.httpStatusCode,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));