import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  fetchEvidence,
  KetchCancelledError,
  KetchCommandError,
  KetchTimeoutError,
  runKetch,
  searchEvidence,
  validateHttpUrl,
} from "../src/ketch/client.ts";

let fixtureDir: string;
let fixture: string;

before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "pi-ketch-fixture-"));
  fixture = join(fixtureDir, "ketch-fixture.js");
  await writeFile(
    fixture,
    `const [command, ...args] = process.argv.slice(2);
if (command === "sleep") setTimeout(() => {}, 10_000);
else if (command === "huge") process.stdout.write("x".repeat(100_000));
else if (command === "stream") { for(let n=0;n<20;n++) process.stdout.write(JSON.stringify({n})+'\\n'); setTimeout(()=>{},10_000); }
else if (command === "fail") { process.stderr.write("fixture failure"); process.exit(7); }
else if (command === "search") process.stdout.write(JSON.stringify({results:[{title:"Example",url:"https://example.test/a",snippet:"evidence"}], args}));
else if (command === "scrape") process.stdout.write(JSON.stringify({url:args.at(-1),title:"Page",content:"clean evidence",args}));
else if (command === "env") process.stdout.write(JSON.stringify({secret:process.env.PI_KETCH_FIXTURE_SECRET ?? null,home:process.env.HOME,config:process.env.XDG_CONFIG_HOME}));
else process.stdout.write(JSON.stringify({command,args}));
`,
    "utf8",
  );
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("ketch client safety and process contract", () => {
  it("only accepts HTTP(S) URLs", () => {
    assert.equal(validateHttpUrl("https://example.test/path"), "https://example.test/path");
    assert.throws(() => validateHttpUrl("file:///etc/passwd"), { code: "INVALID_URL_SCHEME" });
    assert.throws(() => validateHttpUrl("not a url"), { code: "INVALID_URL" });
  });

  it("runs a JavaScript fixture through Node without a shell", async () => {
    const response = await runKetch(["echo", "value with spaces", "--json"], { binary: fixture });
    assert.deepEqual(response.parsed, {
      command: "echo",
      args: ["value with spaces", "--json"],
    });
    assert.equal(response.code, 0);
    assert.equal(response.command, process.execPath);
    assert.deepEqual(response.args.slice(0, 1), [fixture]);
  });

  it("keeps ambient secrets out while isolating the fixture environment", async () => {
    const previous = process.env.PI_KETCH_FIXTURE_SECRET;
    process.env.PI_KETCH_FIXTURE_SECRET = "ambient-secret";
    try {
      const response = await runKetch(["env"], { binary: fixture });
      const parsed = response.parsed as { secret: unknown; home: unknown; config: unknown };
      assert.equal(parsed.secret, null);
      assert.equal(typeof parsed.home, "string");
      assert.equal(typeof parsed.config, "string");
      assert.notEqual(parsed.home, process.env.HOME);
    } finally {
      if (previous === undefined) delete process.env.PI_KETCH_FIXTURE_SECRET;
      else process.env.PI_KETCH_FIXTURE_SECRET = previous;
    }
  });

  it("preserves structured evidence for search and fetch adapters", async () => {
    const search = await searchEvidence("pi", { binary: fixture });
    assert.equal(search.results[0]?.url, "https://example.test/a");
    assert.equal(search.results[0]?.snippet, "evidence");

    const fetch = await fetchEvidence("https://example.test/a", { binary: fixture });
    assert.equal(fetch.title, "Page");
    assert.equal(fetch.content, "clean evidence");
  });

  it("stops streaming at the record cap and keeps positional queries literal", async () => {
    const streamed = await runKetch(["stream"], { binary: fixture, maxRecords: 2 });
    assert.equal(streamed.limited, true);
    assert.deepEqual(streamed.parsed, [{n:0},{n:1}]);
    const found = await searchEvidence("--backend=malicious", { binary: fixture });
    assert.deepEqual((found.raw as {args:string[]}).args.slice(-2), ["--", "--backend=malicious"]);
  });

  it("reports non-zero exits", async () => {
    await assert.rejects(
      runKetch(["fail"], { binary: fixture }),
      (error: unknown) => error instanceof KetchCommandError && error.exitCode === 7,
    );
  });

  it("bounds timeout, cancellation, and captured output", async () => {
    await assert.rejects(
      runKetch(["sleep"], { binary: fixture, timeoutMs: 25 }),
      (error: unknown) => error instanceof KetchTimeoutError,
    );

    const controller = new AbortController();
    const pending = runKetch(["sleep"], { binary: fixture, timeoutMs: 1_000, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof KetchCancelledError);

    await assert.rejects(
      runKetch(["huge"], { binary: fixture, maxOutputBytes: 1_000 }),
      { code: "KETCH_OUTPUT_LIMIT" },
    );
  });
});
