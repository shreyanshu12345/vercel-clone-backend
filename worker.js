export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const host = request.headers.get("host") || "";
    const subdomain = host.split(".")[0] || "";

    const candidateBases = [
      `output/${subdomain}/dist/`,
      `output/${subdomain}/build/`,
      `output/${subdomain}/`,
    ];

    let key = url.pathname.replace(/^\//, "");

    if (!key || key.endsWith("/")) {
      key += "index.html";
    }

    if (key.endsWith("index.html") && url.pathname !== "/") {
      const cleanUrl = url.origin + url.pathname.replace(/index\.html$/, "");
      return Response.redirect(cleanUrl, 301);
    }

    const mimeTypes = {
      html: "text/html",
      css: "text/css",
      js: "application/javascript",
      mjs: "application/javascript",
      json: "application/json",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      ico: "image/x-icon",
      webp: "image/webp",
      woff: "font/woff",
      woff2: "font/woff2",
      ttf: "font/ttf",
      eot: "application/vnd.ms-fontobject",
      mp4: "video/mp4",
      txt: "text/plain",
      pdf: "application/pdf",
    };

    const getContentType = (k) => {
      const ext = k.split(".").pop().toLowerCase();
      return mimeTypes[ext] || "application/octet-stream";
    };

    const serveObject = async (k) => {
      const object = await env.BUCKET.get(k);
      if (!object) return null;
      const headers = new Headers();
      headers.set("Content-Type", getContentType(k));
      headers.set(
        "Cache-Control",
        k.endsWith(".html")
          ? "no-cache"
          : "public, max-age=31536000, immutable"
      );
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(object.body, { headers });
    };

    const resolveBase = async () => {
      for (const base of candidateBases) {
        const probe = await env.BUCKET.get(base + "index.html");
        if (probe) return base;
      }
      return null;
    };

    const hasExtension = /\.[a-zA-Z0-9]+$/.test(key);

    try {
      const basePath = await resolveBase();

      if (!basePath) {
        return new Response(
          [
            "404 — No site found for: " + subdomain,
            "Tried:",
            ...candidateBases.map((b) => "  " + b + "index.html"),
          ].join("\n"),
          { status: 404, headers: { "Content-Type": "text/plain" } }
        );
      }

      // 1. Exact file
      let response = await serveObject(basePath + key);
      if (response) return response;

      // 2. Asset fallback
      if (hasExtension) {
        const filename = key.split("/").pop();
        response = await serveObject(basePath + "assets/" + filename);
        if (response) return response;
        response = await serveObject(basePath + filename);
        if (response) return response;
        return new Response("404 — Asset not found: " + key, { status: 404 });
      }

      // 3. SPA fallback
      response = await serveObject(basePath + "index.html");
      if (response) return response;

      return new Response("404 — App not found", { status: 404 });
    } catch (err) {
      return new Response("500 — " + err.message, { status: 500 });
    }
  },
};