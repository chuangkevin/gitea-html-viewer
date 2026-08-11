import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPreviewBaseUrl,
  determineEffectiveGrant,
  shouldServeCssShim,
  generateImportMap,
  injectPreviewHead,
  rewriteCssSideEffectImports,
  createCssShim,
  readWithPublicFallback,
  readClosestPackageJson,
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
    const attempts: string[] = [];
    const pkg = { dependencies: { three: "^0.160.0" } };
    const found = await readClosestPackageJson(async (path) => {
      attempts.push(path);
      if (path === "ai-pair-programming-poc/package.json") {
        throw new ProviderError(404, "File not found");
      }
      if (path === "package.json") {
        return JSON.stringify(pkg);
      }
      throw new Error(`unexpected path: ${path}`);
    }, "ai-pair-programming-poc/index.html");

    assert.deepEqual(found, pkg);
    assert.deepEqual(attempts, ["ai-pair-programming-poc/package.json", "package.json"]);

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
});
