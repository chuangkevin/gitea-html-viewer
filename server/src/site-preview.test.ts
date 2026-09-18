import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPreviewBaseUrl,
  buildCrmAssetCanonicalRedirectLocation,
  determineEffectiveGrant,
  shouldServeCssShim,
  resolvePreviewAssetPath,
  generateImportMap,
  injectPreviewHead,
  rewriteDocumentRelativeAttrs,
  hasFragmentsAffectedByBase,
  rewriteCssSideEffectImports,
  createCssShim,
  readWithPublicFallback,
  readClosestPackageJson,
  hasModuleScript,
  readClosestPackageJsonCached,
} from "./site-preview.js";
import { ProviderError } from "./providers.js";

describe("site-preview module", () => {
  it("builds public and grant preview asset base URLs correctly and encodes folderPath per segment", () => {
    const publicBase = buildPreviewBaseUrl({
      provider: "github",
      project: "user/repo",
      folderPath: "",
    });
    assert.equal(publicBase, "/site-assets/github/user%2Frepo/");

    const publicBaseWithSubfolder = buildPreviewBaseUrl({
      provider: "gitlab",
      project: "group/sub/proj",
      folderPath: "dist/",
    });
    assert.equal(publicBaseWithSubfolder, "/site-assets/gitlab/group%2Fsub%2Fproj/dist/");

    const grantBase = buildPreviewBaseUrl({
      provider: "github",
      project: "user/repo",
      folderPath: "",
      grant: "grant-token-123",
    });
    assert.equal(grantBase, "/site-assetst/grant-token-123/github/user%2Frepo/");

    const specialFolderBase = buildPreviewBaseUrl({
      provider: "github",
      project: "user/repo",
      folderPath: 'my folder/sub "dir"/',
    });
    assert.equal(specialFolderBase, "/site-assets/github/user%2Frepo/my%20folder/sub%20%22dir%22/");
  });

  it("builds the exact CRM asset canonical redirect location", () => {
    const location = buildCrmAssetCanonicalRedirectLocation({
      route: "public",
      provider: "gitlab",
      project: "interagent-io/global-doc",
      filePath: "內部/CRM/crm.html",
    });

    assert.equal(
      location,
      "/site/gitlab/interagent-io%2Fglobal-doc?f=%E5%85%A7%E9%83%A8/CRM/crm.html"
    );
  });

  it("preserves non-f query parameters in order and replaces all incoming f parameters", () => {
    const location = buildCrmAssetCanonicalRedirectLocation({
      route: "public",
      provider: "gitlab",
      project: "interagent-io/global-doc",
      filePath: "內部/CRM/crm.html",
      rawQuery: "f=old&tab=partners&debug=1&f=second&tab=again",
    });

    assert.equal(
      location,
      "/site/gitlab/interagent-io%2Fglobal-doc?tab=partners&debug=1&tab=again&f=%E5%85%A7%E9%83%A8/CRM/crm.html"
    );
    assert.equal(location?.includes("#"), false);
    assert.equal((location?.match(/[?&]f=/g) ?? []).length, 1);
  });

  it("does not build the CRM canonical redirect for non-target route boundaries", () => {
    const base = {
      route: "public" as const,
      provider: "gitlab",
      project: "interagent-io/global-doc",
      filePath: "內部/CRM/crm.html",
    };

    assert.equal(buildCrmAssetCanonicalRedirectLocation({ ...base, provider: "github" }), null);
    assert.equal(buildCrmAssetCanonicalRedirectLocation({ ...base, project: "interagent-io/other" }), null);
    assert.equal(buildCrmAssetCanonicalRedirectLocation({ ...base, filePath: "內部/CRM/index.html" }), null);
    assert.equal(buildCrmAssetCanonicalRedirectLocation({ ...base, filePath: "內部/CRM/customers.html" }), null);
    assert.equal(buildCrmAssetCanonicalRedirectLocation({ ...base, route: "grant" }), null);
  });

  it("resolves preview directory asset paths to index.html and preserves exact paths", () => {
    const cases: Array<[string, string]> = [
      ["", "index.html"],
      ["/", "index.html"],
      ["docs/", "docs/index.html"],
      ["nested/docs/", "nested/docs/index.html"],
      ["內部/CRM/", "內部/CRM/index.html"],
      ["index.html", "index.html"],
      ["pages/about.html", "pages/about.html"],
      ["assets/main.js", "assets/main.js"],
      ["assets/styles.css", "assets/styles.css"],
      ["extensionless", "extensionless"],
    ];

    for (const [input, expected] of cases) {
      assert.equal(resolvePreviewAssetPath(input), expected, input);
    }
  });

  it("determines effective grant correctly based on actor success", () => {
    // Grant query present, grant token resolved, grant actor succeeded
    assert.equal(determineEffectiveGrant("grant-123", "token-abc", true), "grant-123");

    // Grant query present, grant token resolved, but fell back (usingGrant = false)
    assert.equal(determineEffectiveGrant("grant-123", "token-abc", false), null);

    // Grant query present, but grant token unresolved
    assert.equal(determineEffectiveGrant("grant-123", null, false), null);

    // Missing grant query
    assert.equal(determineEffectiveGrant(null, "token-abc", true), null);
    assert.equal(determineEffectiveGrant("", "token-abc", true), null);
  });

  it("determines when to serve CSS shim correctly", () => {
    // css + 1 -> true
    assert.equal(shouldServeCssShim("style.css", "1"), true);
    assert.equal(shouldServeCssShim("assets/theme/dark.CSS", "1"), true);

    // css + 0 -> false
    assert.equal(shouldServeCssShim("style.css", "0"), false);

    // js + 1 -> false
    assert.equal(shouldServeCssShim("main.js", "1"), false);

    // array query -> false
    assert.equal(shouldServeCssShim("style.css", ["1"]), false);

    // undefined / empty query -> false
    assert.equal(shouldServeCssShim("style.css", undefined), false);
    assert.equal(shouldServeCssShim("style.css", ""), false);
  });

  it("generates import map with three/three prefix and strips range prefixes and rejects malicious names", () => {
    const pkg = {
      dependencies: {
        three: "^0.160.0",
        "lucide-react": "~0.300.0",
        "@types/three": ">=0.160.0",
        "<script>alert(1)</script>": "1.0.0",
        "../malicious": "1.0.0",
      },
      devDependencies: {
        vite: "5.0.0",
      },
    };
    const map = generateImportMap(pkg);
    assert.equal(map.imports["three"], "https://esm.sh/three@0.160.0");
    assert.equal(map.imports["three/"], "https://esm.sh/three@0.160.0/");
    assert.equal(map.imports["lucide-react"], "https://esm.sh/lucide-react@0.300.0");
    assert.equal(map.imports["lucide-react/"], "https://esm.sh/lucide-react@0.300.0/");
    assert.equal(map.imports["@types/three"], "https://esm.sh/@types/three@0.160.0");
    assert.equal(map.imports["@types/three/"], "https://esm.sh/@types/three@0.160.0/");
    assert.equal(map.imports["vite"], "https://esm.sh/vite@5.0.0");
    assert.equal(map.imports["<script>alert(1)</script>"], undefined);
    assert.equal(map.imports["../malicious"], undefined);
  });

  it("injects base and importmap in order before the first type=module script", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Test</title>
  <script type="module" src="./main.js"></script>
</head>
<body></body>
</html>`;
    const base = "/site-assets/github/owner%2Frepo/";
    const importMap = { imports: { three: "https://esm.sh/three@0.160.0" } };
    const injected = injectPreviewHead(html, base, importMap);

    const baseIndex = injected.indexOf(`<base href="${base}">`);
    const importmapIndex = injected.indexOf(`<script type="importmap">`);
    const scriptIndex = injected.indexOf(`<script type="module" src="./main.js">`);

    assert.ok(baseIndex !== -1, "base tag should exist");
    assert.ok(importmapIndex !== -1, "importmap tag should exist");
    assert.ok(scriptIndex !== -1, "module script tag should exist");
    assert.ok(baseIndex < importmapIndex, "base tag should come before importmap tag");
    assert.ok(importmapIndex < scriptIndex, "importmap tag should come before first module script");
  });

  it("replaces existing base tag in HTML, ensuring single base tag and correct order", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <base href="/old-base/">
  <meta charset="utf-8">
  <title>Test</title>
  <script type="module" src="./main.js"></script>
</head>
<body></body>
</html>`;
    const base = "/site-assets/github/owner%2Frepo/";
    const injected = injectPreviewHead(html, base);

    const baseMatches = injected.match(/<base\b[^>]*>/gi);
    assert.equal(baseMatches?.length, 1, "should contain exactly one base tag");
    assert.ok(!injected.includes("/old-base/"), "old base href should be removed");
    assert.ok(injected.includes(`<base href="${base}">`), "new base href should be present");

    const baseIndex = injected.indexOf(`<base href="${base}">`);
    const scriptIndex = injected.indexOf(`<script type="module" src="./main.js">`);
    assert.ok(baseIndex < scriptIndex, "base tag should come before first module script");
  });

  it("rewrites fragment-only and query-only href/action so injected <base> cannot hijack them", () => {
    const html = `<!DOCTYPE html>
<html><head></head><body>
  <a href="#form">申請</a>
  <a href="#subsidy-overview">總覽</a>
  <form id="subsidy-form" action="#form" method="post"><input name="x"></form>
  <a href="https://example.com/x">外部</a>
  <a href="./other.html">相對檔</a>
  <img src="./pic.png">
  <a href="?page=2">下一頁</a>
</body></html>`;
    const docPath = "/site/gitlab/org%2Frepo?f=a.html";
    const out = rewriteDocumentRelativeAttrs(html, docPath);

    // fragment-only → 指向本文件（保留原 query），不再落到 /site-assets/...
    assert.ok(out.includes(`href="/site/gitlab/org%2Frepo?f=a.html#form"`), "should absolutize href=#form");
    assert.ok(out.includes(`action="/site/gitlab/org%2Frepo?f=a.html#form"`), "should absolutize action=#form");
    assert.ok(out.includes(`href="/site/gitlab/org%2Frepo?f=a.html#subsidy-overview"`), "should handle multiple fragments");
    assert.ok(out.includes(`href="/site/gitlab/org%2Frepo?f=a.html?page=2"`), "should absolutize query-only");

    // 其他屬性一律不動
    assert.ok(out.includes(`href="https://example.com/x"`), "absolute URL must be untouched");
    assert.ok(out.includes(`href="./other.html"`), "relative file path must be untouched");
    assert.ok(out.includes(`src="./pic.png"`), "relative src must be untouched");
  });

  it("hasFragmentsAffectedByBase detects only document-relative href/action", () => {
    assert.equal(hasFragmentsAffectedByBase(`<a href="#form">x</a>`), true);
    assert.equal(hasFragmentsAffectedByBase(`<form action="#form"></form>`), true);
    assert.equal(hasFragmentsAffectedByBase(`<a href="?p=1">x</a>`), true);
    assert.equal(hasFragmentsAffectedByBase(`<a href="./a.html">x</a>`), false);
    assert.equal(hasFragmentsAffectedByBase(`<a href="https://x/#y">x</a>`), false);
    assert.equal(hasFragmentsAffectedByBase(`<img src="#icon">`), false);
  });

  it("leaves fragment links untouched when no documentPath is provided", () => {
    const html = `<a href="#form">x</a>`;
    const out = rewriteDocumentRelativeAttrs(html, "");
    assert.equal(out, html, "empty documentPath should be a no-op");
  });

  it("prevents script-close injection in importmap JSON", () => {
    const html = `<html><head></head><body></body></html>`;
    const importMap = {
      imports: {
        evil: "https://esm.sh/evil</script><script>alert(1)</script>",
      },
    };
    const injected = injectPreviewHead(html, "/base/", importMap);
    assert.equal(injected.includes("</script><script>alert(1)</script>"), false);
    assert.ok(injected.includes("\\u003c/script"), "should escape script closing tag");
  });

  it("rewrites JS side-effect CSS imports and leaves normal imports and comments unchanged", () => {
    const code = `
// import './ignored1.css'
/* import './ignored2.css' */
import './style.css';
import "./app.css";
import { render } from './other.js';
import css from './styles.module.css';
const str = "import './string.css'";
    `;
    const rewritten = rewriteCssSideEffectImports(code);
    assert.ok(rewritten.includes(`import './style.css?site_preview_css=1';`));
    assert.ok(rewritten.includes(`import "./app.css?site_preview_css=1";`));
    assert.ok(rewritten.includes(`// import './ignored1.css'`));
    assert.ok(rewritten.includes(`/* import './ignored2.css' */`));
    assert.ok(rewritten.includes(`import { render } from './other.js';`));
    assert.ok(rewritten.includes(`import css from './styles.module.css';`));
    assert.ok(rewritten.includes(`const str = "import './string.css'";`));
  });

  it("creates CSS shim that removes site_preview_css query and deduplicates link elements", () => {
    const shim = createCssShim();
    assert.ok(shim.includes("site_preview_css"), "shim should reference site_preview_css parameter");
    assert.ok(shim.includes("link"), "shim should manipulate link tag");
    assert.ok(shim.includes("stylesheet"), "shim should set rel=stylesheet");
  });

  it("readWithPublicFallback retries public/<path> only on 404 and handles favicon fallback", async () => {
    const mockFiles: Record<string, string> = {
      "public/app.js": "console.log('public app');",
      "public/favicon.svg": "<svg>favicon</svg>",
    };

    const mockRead = async (path: string) => {
      if (path === "500-error.js") {
        throw new ProviderError(500, "Internal Server Error");
      }
      if (path === "401-error.js") {
        throw new ProviderError(401, "Unauthorized");
      }
      if (mockFiles[path]) {
        return mockFiles[path];
      }
      throw new ProviderError(404, `File not found: ${path}`);
    };

    // Case 1: direct hit in public
    const res1 = await readWithPublicFallback(mockRead, "app.js");
    assert.equal(res1, "console.log('public app');");

    // Case 2: 500 error is thrown directly, no fallback
    await assert.rejects(
      async () => readWithPublicFallback(mockRead, "500-error.js"),
      (err: any) => err instanceof ProviderError && err.status === 500
    );

    // Case 3: 401 error is thrown directly, no fallback
    await assert.rejects(
      async () => readWithPublicFallback(mockRead, "401-error.js"),
      (err: any) => err instanceof ProviderError && err.status === 401
    );

    // Case 4: root favicon missing falls back to public/favicon.svg
    const resFavicon = await readWithPublicFallback(mockRead, "favicon.ico");
    assert.equal(resFavicon, "<svg>favicon</svg>");
  });

  it("reads closest ancestor package.json for source previews and propagates non-404 provider errors", async () => {
    const directAttempts: string[] = [];
    const directPkg = { dependencies: { three: "^0.160.0" } };
    const direct = await readClosestPackageJson(async (path) => {
      directAttempts.push(path);
      if (path === "ai-pair-programming-poc/package.json") {
        return JSON.stringify(directPkg);
      }
      throw new ProviderError(404, "File not found");
    }, "ai-pair-programming-poc/index.html");

    assert.deepEqual(direct, directPkg);
    assert.deepEqual(directAttempts, ["ai-pair-programming-poc/package.json"]);

    const fallbackAttempts: string[] = [];
    const fallbackPkg = { dependencies: { three: "^0.161.0" } };
    const fallback = await readClosestPackageJson(async (path) => {
      fallbackAttempts.push(path);
      if (path === "package.json") {
        return JSON.stringify(fallbackPkg);
      }
      throw new ProviderError(404, "File not found");
    }, "ai-pair-programming-poc/demo/index.html");

    assert.deepEqual(fallback, fallbackPkg);
    assert.deepEqual(fallbackAttempts, [
      "ai-pair-programming-poc/demo/package.json",
      "ai-pair-programming-poc/package.json",
      "package.json",
    ]);

    const failedAttempts: string[] = [];
    await assert.rejects(
      async () => readClosestPackageJson(async (path) => {
        failedAttempts.push(path);
        throw new ProviderError(500, "Internal Server Error");
      }, "ai-pair-programming-poc/index.html"),
      (err: any) => err instanceof ProviderError && err.status === 500
    );
    assert.deepEqual(failedAttempts, ["ai-pair-programming-poc/package.json"]);
  });

  it("simulates weather fixture project structure (index.html, main.js, package.json)", () => {
    const pkg = {
      name: "weather-app",
      dependencies: {
        three: "^0.160.0",
      },
    };
    const importMap = generateImportMap(pkg);
    assert.equal(importMap.imports["three"], "https://esm.sh/three@0.160.0");

    const rawHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Weather App</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./main.js"></script>
</body>
</html>`;
    const base = "/site-assets/github/owner%2Fweather/";
    const htmlWithMap = injectPreviewHead(rawHtml, base, importMap);
    assert.ok(htmlWithMap.includes(`<base href="${base}">`));
    assert.ok(htmlWithMap.includes(`https://esm.sh/three@0.160.0`));

    const mainJs = `
import './style.css';
import * as THREE from 'three';

console.log('weather main loaded', THREE);
    `;
    const transformedJs = rewriteCssSideEffectImports(mainJs);
    assert.ok(transformedJs.includes(`import './style.css?site_preview_css=1';`));
    assert.ok(transformedJs.includes(`import * as THREE from 'three';`));
  });

  it("hasModuleScript detects type=module with quotes and attribute order, and ignores ordinary scripts", () => {
    assert.equal(hasModuleScript(`<script type="module" src="./main.js"></script>`), true);
    assert.equal(hasModuleScript(`<script src="./app.js"></script>`), false);
    assert.equal(hasModuleScript(`<script type='module' src="./main.js"></script>`), true);
    assert.equal(hasModuleScript(`<script src="./main.js" type="module"></script>`), true);
    assert.equal(hasModuleScript(`<script type="text/javascript" src="./app.js"></script>`), false);
  });

  it("caches closest package.json lookups including 404s, isolates directories, and does not cache non-404 errors", async () => {
    const hitPkg = { name: "cached-hit" };
    let hitCalls = 0;
    const hitRead = async (pkgPath: string) => {
      hitCalls += 1;
      if (pkgPath === "app/package.json") {
        return JSON.stringify(hitPkg);
      }
      throw new ProviderError(404, "File not found");
    };
    const hitPrefix = "gitlab|cache-hit-proj";
    const firstHit = await readClosestPackageJsonCached(hitPrefix, hitRead, "app/index.html");
    const secondHit = await readClosestPackageJsonCached(hitPrefix, hitRead, "app/index.html");
    assert.deepEqual(firstHit, hitPkg);
    assert.deepEqual(secondHit, hitPkg);
    assert.equal(hitCalls, 1, "same directory should reuse the first lookup");

    let missCalls = 0;
    const missRead = async () => {
      missCalls += 1;
      throw new ProviderError(404, "File not found");
    };
    const missPrefix = "gitlab|cache-miss-proj";
    const firstMiss = await readClosestPackageJsonCached(missPrefix, missRead, "deep/nested/index.html");
    const secondMiss = await readClosestPackageJsonCached(missPrefix, missRead, "deep/nested/index.html");
    assert.equal(firstMiss, null);
    assert.equal(secondMiss, null);
    assert.equal(missCalls, 3, "404/null result should be cached after the first walk");

    let dirCalls = 0;
    const dirRead = async (pkgPath: string) => {
      dirCalls += 1;
      if (pkgPath === "a/package.json") {
        return JSON.stringify({ name: "dir-a" });
      }
      if (pkgPath === "b/package.json") {
        return JSON.stringify({ name: "dir-b" });
      }
      throw new ProviderError(404, "File not found");
    };
    const dirPrefix = "gitlab|cache-dir-proj";
    const fromA = await readClosestPackageJsonCached(dirPrefix, dirRead, "a/index.html");
    const fromB = await readClosestPackageJsonCached(dirPrefix, dirRead, "b/index.html");
    assert.deepEqual(fromA, { name: "dir-a" });
    assert.deepEqual(fromB, { name: "dir-b" });
    assert.equal(dirCalls, 2, "different directories must not share cache entries");

    let errorCalls = 0;
    const errorRead = async () => {
      errorCalls += 1;
      throw new ProviderError(500, "Internal Server Error");
    };
    const errorPrefix = "gitlab|cache-error-proj";
    await assert.rejects(
      async () => readClosestPackageJsonCached(errorPrefix, errorRead, "err/index.html"),
      (err: any) => err instanceof ProviderError && err.status === 500
    );
    await assert.rejects(
      async () => readClosestPackageJsonCached(errorPrefix, errorRead, "err/index.html"),
      (err: any) => err instanceof ProviderError && err.status === 500
    );
    assert.equal(errorCalls, 2, "non-404 errors must not be cached");
  });
});
