/**
 * Azure OpenAI Proxy — adds api-version query parameter and store:true to all requests.
 *
 * OpenClaw's openai-responses API type calls POST {baseUrl}/responses
 * but Azure requires ?api-version=... on every request, and defaults store=false
 * which breaks conversation continuity.
 *
 * This proxy transparently:
 * 1. Adds ?api-version=... to every request
 * 2. Injects "store": true into POST /responses body
 *
 * Configuration via environment variables (or .env.local):
 *   AZURE_OPENAI_ENDPOINT  — Azure OpenAI resource URL (required)
 *   AZURE_OPENAI_API_VERSION — API version (default: 2025-04-01-preview)
 *   PROXY_PORT — Local proxy port (default: 4200)
 *
 * Start: node azure-proxy.js
 * Then set OpenClaw baseUrl to http://localhost:{PROXY_PORT}/openai
 */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// Load .env.local if present (same directory as this script)
const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2025-04-01-preview";
const PORT = parseInt(process.env.PROXY_PORT || "4200", 10);

if (!AZURE_ENDPOINT) {
  console.error("Error: AZURE_OPENAI_ENDPOINT environment variable is required.");
  console.error("Set it in .env.local or export it before running this script.");
  console.error("Example: AZURE_OPENAI_ENDPOINT=https://your-resource.cognitiveservices.azure.com");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // Build target URL: Azure endpoint + request path + api-version
  const targetUrl = new URL(req.url, AZURE_ENDPOINT);
  targetUrl.searchParams.set("api-version", API_VERSION);

  // Buffer the request body to inject "store": true for Responses API
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = Buffer.concat(chunks);

    // For POST requests to /responses, inject store: true
    if (req.method === "POST" && req.url.includes("/responses")) {
      try {
        const parsed = JSON.parse(body.toString());
        if (parsed.store === undefined || parsed.store === false) {
          parsed.store = true;
        }
        body = Buffer.from(JSON.stringify(parsed));
      } catch (_) {
        // If body isn't valid JSON, pass through unchanged
      }
    }

    const options = {
      hostname: targetUrl.hostname,
      port: 443,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.hostname,
        "content-length": body.length,
      },
    };

    // Remove proxy-specific headers
    delete options.headers["connection"];

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error("Proxy error:", err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: "Proxy error", detail: err.message }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`Azure OpenAI proxy listening on http://localhost:${PORT}`);
  console.log(
    `Forwarding to ${AZURE_ENDPOINT} with api-version=${API_VERSION}`,
  );
});
