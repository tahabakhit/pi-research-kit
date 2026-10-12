import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolveKetchCommand, runKetch, parseSearchEvidence, parseScrapeEvidence, validateHttpUrl } from '../src/ketch/client.ts';

// Actual pinned binary against a local controlled server. No external provider.
test('pinned Ketch 0.17.1 emits compatible search and scrape JSON', async t => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/search')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({results:[{url:'https://example.com/article',title:'Fixture',content:'A local search snippet'}]}));
    } else {
      res.setHeader('content-type','text/html');
      res.end('<html><head><title>Fixture article</title></head><body><article><p>' + 'Controlled fixture article text for extraction. '.repeat(80) + '</p></article></body></html>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const resolved = resolveKetchCommand();
  assert.deepEqual(resolved.prefixArgs, [], 'supported npm platforms use the direct native binary');
  assert.match(resolved.command, /node_modules[\\/]@ketch-cli[\\/](darwin|linux|win32)-(x64|arm64)[\\/]bin[\\/]ketch(?:\.exe)?$/);
  assert.match((await runKetch(['--version'])).stdout, /v0\.17\.1/);
  const search = await runKetch(['search','--json','--backend','searxng','--searxng-url',url,'--','--injection-shaped-query']);
  const items = parseSearchEvidence(search.parsed);
  assert.equal(items[0]?.snippet, 'A local search snippet');
  const scrape = await runKetch(['scrape','--json','--no-cache','--no-llms-txt','--',`${url}/article`]);
  assert.match(parseScrapeEvidence(scrape.parsed).content!, /Controlled fixture/);
});

test('rejects malformed evidence instead of reporting empty coverage', () => {
  assert.throws(() => parseSearchEvidence({unexpected: []}), /schema/);
  assert.throws(() => parseSearchEvidence([{url:'https://example.com',title:5}]), /schema/);
  assert.throws(() => parseScrapeEvidence({url:'https://example.com'}), /schema/);
  assert.deepEqual(parseSearchEvidence([]), []);
});

test('rejects private mapped IPv6 and URL credentials', () => {
  for (const url of ['http://[::ffff:127.0.0.1]/','http://[::ffff:7f00:1]/','http://[::ffff:a00:1]/','http://user:pass@example.com/','http://127.1/']) assert.throws(() => validateHttpUrl(url));
});
