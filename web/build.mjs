import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const templatePath = path.join(__dirname, "template.html");
const cssEntryPath = path.join(__dirname, "src", "styles", "main.css");
const jsEntryPath = path.join(__dirname, "src", "main.js");
const outHtmlPath = path.join(rootDir, "src", "ui.html");
const cargoTomlPath = path.join(rootDir, "Cargo.toml");

function readCargoVersion() {
  try {
    const raw = fs.readFileSync(cargoTomlPath, "utf8");
    const m = raw.match(/^version\s*=\s*"([^"]+)"/m);
    return m ? m[1] : "0.4.0";
  } catch (_) {
    return "0.4.0";
  }
}

const isCheckMode = process.argv.includes("--check");

async function buildBundle() {
  const cargoVersion = readCargoVersion();
  const [templateHtml, cssResult, jsResult] = await Promise.all([
    fs.promises.readFile(templatePath, "utf8"),
    esbuild.build({
      entryPoints: [cssEntryPath],
      bundle: true,
      minify: false,
      write: false,
      charset: "utf8",
    }),
    esbuild.build({
      entryPoints: [jsEntryPath],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["chrome110", "edge110", "firefox115", "safari16"],
      minify: false,
      write: false,
      charset: "utf8",
      define: {
        __DROCSID_APP_VERSION__: JSON.stringify(cargoVersion),
      },
      loader: {
        ".wasm": "binary",
      },
      plugins: [
        {
          name: "worklet-text-loader",
          setup(build) {
            // Permite importar "?text" (ex.: AudioWorklet processors em Blob URL, relativos ou pacotes npm)
            build.onResolve({ filter: /\?text$/ }, (args) => {
              const rawSpec = args.path.replace(/\?text$/, "");
              const resolvedPath = rawSpec.startsWith(".")
                ? path.resolve(args.resolveDir, rawSpec)
                : require.resolve(rawSpec, { paths: [args.resolveDir, rootDir] });
              return {
                path: resolvedPath,
                namespace: "worklet-text",
              };
            });
            build.onLoad({ filter: /.*/, namespace: "worklet-text" }, async (args) => {
              const contents = await fs.promises.readFile(args.path, "utf8");
              return { contents, loader: "text" };
            });
          },
        },
      ],
    }),
  ]);

  const cssText = cssResult.outputFiles[0].text.trimEnd();
  // Impede fechamento prematuro da tag <script> dentro de strings/templates inline
  const jsText = jsResult.outputFiles[0].text
    .replace(/<\/(script)/gi, "<\\/$1")
    .trimEnd();

  if (!templateHtml.includes("/* __DROCSID_INLINE_CSS__ */")) {
    throw new Error("Marcador /* __DROCSID_INLINE_CSS__ */ ausente em web/template.html");
  }
  if (!templateHtml.includes("/* __DROCSID_INLINE_JS__ */")) {
    throw new Error("Marcador /* __DROCSID_INLINE_JS__ */ ausente em web/template.html");
  }

  const finalHtml = templateHtml
    .replace("/* __DROCSID_INLINE_CSS__ */", () => cssText)
    .replace("/* __DROCSID_INLINE_JS__ */", () => jsText);

  return { templateHtml, cssText, jsText, finalHtml };
}

function validateIntegrity({ templateHtml, jsText, finalHtml }) {
  const errors = [];

  // 1. Validação sintática completa do JS gerado
  try {
    new Function(jsText);
  } catch (err) {
    errors.push(`Erro de sintaxe JS no bundle gerado: ${err.message}`);
  }

  // 2. Verifica se todos os handlers inline (onclick, oninput, onchange, onsubmit) existem no window
  const handlerNames = new Set();
  const inlineHandlerRe = /\son(?:click|input|change|submit)="([a-zA-Z0-9_$]+)\(/g;
  for (const srcText of [templateHtml, ...readAllSrcFiles(path.join(__dirname, "src"))]) {
    let m;
    while ((m = inlineHandlerRe.exec(srcText)) !== null) {
      handlerNames.add(m[1]);
    }
  }

  const mainJsSource = fs.readFileSync(jsEntryPath, "utf8");
  for (const name of handlerNames) {
    const exposedInWindow =
      new RegExp(`\\b${name}\\b`).test(mainJsSource) ||
      finalHtml.includes(`window.${name}`);
    if (!exposedInWindow) {
      errors.push(`Handler inline "${name}(...)" usado no HTML mas não exposto em web/src/main.js`);
    }
  }

  // 3. Verifica se getElementById("literal") referencia ID existente em web/template.html
  const htmlIds = new Set();
  const idRe = /\bid="([a-zA-Z0-9_-]+)"/g;
  let idMatch;
  while ((idMatch = idRe.exec(templateHtml)) !== null) {
    htmlIds.add(idMatch[1]);
  }
  const dynamicIdPatterns = [
    /^pipProxyVideoEl$/,
  ];
  const srcFiles = readAllSrcFiles(path.join(__dirname, "src"));
  const getByIdRe = /document\.getElementById\("([a-zA-Z0-9_-]+)"\)/g;
  for (const content of srcFiles) {
    let gm;
    while ((gm = getByIdRe.exec(content)) !== null) {
      const targetId = gm[1];
      if (!htmlIds.has(targetId) && !dynamicIdPatterns.some((rx) => rx.test(targetId))) {
        errors.push(`document.getElementById("${targetId}") não encontrado em web/template.html`);
      }
    }
  }

  // 4. Garante zero referência a CDNs externos no HTML final e zero alert/confirm/prompt bloqueante
  if (/https?:\/\/(cdn\.|unpkg\.com|jsdelivr\.net|cdnjs\.)/i.test(finalHtml)) {
    errors.push("URL de CDN externa detectada no HTML final — proibido pelo modo offline.");
  }
  for (const content of srcFiles) {
    if (/(^|[^\w.])(?:alert|confirm|prompt)\s*\(/m.test(content)) {
      errors.push("Chamada bloqueante alert/confirm/prompt encontrada em web/src/");
    }
  }

  return errors;
}

function readAllSrcFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readAllSrcFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(fs.readFileSync(full, "utf8"));
    }
  }
  return out;
}

async function main() {
  const built = await buildBundle();
  const errors = validateIntegrity(built);
  if (errors.length > 0) {
    console.error("Falhas na validação de build web:");
    for (const err of errors) console.error(" - " + err);
    process.exit(1);
  }

  if (isCheckMode) {
    const diskHtml = fs.existsSync(outHtmlPath) ? fs.readFileSync(outHtmlPath, "utf8") : "";
    if (diskHtml !== built.finalHtml) {
      console.error("src/ui.html está desatualizado em relação a web/. Execute: npm run build");
      process.exit(1);
    }
    console.log(`Check OK: ${built.finalHtml.length} bytes, sintaxe JS e referências DOM válidas.`);
    return;
  }

  await fs.promises.writeFile(outHtmlPath, built.finalHtml, "utf8");
  const kb = (Buffer.byteLength(built.finalHtml, "utf8") / 1024).toFixed(1);
  console.log(`Build OK -> src/ui.html (${kb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
