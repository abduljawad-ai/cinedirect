// Local harness: runs the Cloudflare Worker handler as an HTTP server on
// the given port (default 8300) so the relay can be tested end-to-end.
// Usage: node harness.mjs [port]
import { createServer } from "node:http";
import relay from "./relay.js";

const port = parseInt(process.argv[2] || "8300", 10);

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const request = new Request("http://localhost:" + port + req.url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "POST" ? body : undefined,
      redirect: "manual",
    });
    try {
      const resp = await relay.fetch(request);
      res.writeHead(resp.status, Object.fromEntries(resp.headers));
      const reader = resp.body.getReader();
      // Limit passthrough for tests: cap the relayed body at 64KB so the
      // harness never drains a multi-GB file.
      let sent = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        let chunk = value;
        if (sent + chunk.length > 65536) {
          chunk = chunk.subarray(0, 65536 - sent);
          res.write(Buffer.from(chunk));
          res.end();
          return;
        }
        sent += chunk.length;
        res.write(Buffer.from(chunk));
      }
      res.end();
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("harness error: " + e.message);
    }
  });
});

server.listen(port, () => console.log("relay harness listening on http://localhost:" + port));