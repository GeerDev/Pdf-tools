import { join } from "node:path";
import { access } from "node:fs/promises";
import { obtenerTodasFacturas, cerrarConexion, guardarFactura } from "./mongo";
import { extraerDatosFacturaRegex, type DatosFactura } from "./regex";
import { extraerDatosFacturaPdfJs } from "./pdfjs";

const CARPETA_PDFS = "./pdfs";

interface Issue {
  archivo: string;
  campo: string;
  valor: any;
  motivo: string;
}

interface DiffMongoVsActual {
  archivo: string;
  campo: string;
  enMongo: any;
  reExtraido: any;
}

// ── Patrones canónicos ────────────────────────────────────────────────────────
const RE_FECHA       = /^\d{2}\/\d{2}\/(\d{2}|\d{4})$/;
const RE_NFACTURA    = /^[A-Z][A-Z\s]*\d+$/;
const RE_CIF         = /^(?:[A-Z]-\d{8}-\d|[A-Z]-\d{8}|[A-Z]\d{9}|[A-Z]\d{8}|[A-Z]\d{7}[A-Z]|[A-Z]\d{7}|\d{8}[A-Z])$/;
const RE_TELEFONO    = /^\d{9}$/;
const RE_TOTAL       = /^-?\d+(?:\.\d{3})*,\d+\s*€$/;
const RE_NUMERO      = /^-?\d+(?:\.\d{3})*,\d+$/;

const CIF_EMISOR_ESPERADO = "B98400054"; // DIECAR

function parseNumeroES(s: string | undefined): number | null {
  if (!s) return null;
  const limpio = s.replace(/\s|€/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

// ── 1) Validación de formato sobre lo que está en mongo ───────────────────────
function validarFormato(f: any): Issue[] {
  const issues: Issue[] = [];
  const push = (campo: string, valor: any, motivo: string) =>
    issues.push({ archivo: f.archivo, campo, valor, motivo });

  for (const campo of ["nFactura", "fecha", "cliente", "telefono", "cifEmisor", "cifReceptor", "total"]) {
    const v: string = f[campo];
    if (!v || /^no encontrad/i.test(v)) push(campo, v, "vacío o 'No encontrado'");
  }

  if (f.fecha && !/^no encontrad/i.test(f.fecha) && !RE_FECHA.test(f.fecha)) {
    push("fecha", f.fecha, "formato inválido");
  }
  if (f.nFactura && !/^no encontrad/i.test(f.nFactura) && !RE_NFACTURA.test(f.nFactura)) {
    push("nFactura", f.nFactura, "formato inválido");
  }
  if (f.cifEmisor && !/^no encontrad/i.test(f.cifEmisor) && f.cifEmisor !== CIF_EMISOR_ESPERADO) {
    push("cifEmisor", f.cifEmisor, `esperado ${CIF_EMISOR_ESPERADO} (DIECAR)`);
  }
  if (f.cifReceptor && !/^no encontrad/i.test(f.cifReceptor) && !RE_CIF.test(f.cifReceptor)) {
    push("cifReceptor", f.cifReceptor, "formato CIF/NIF inválido");
  }
  if (f.telefono && !/^no encontrad/i.test(f.telefono) && !RE_TELEFONO.test(f.telefono.replace(/\s/g, ""))) {
    push("telefono", f.telefono, "no son 9 dígitos");
  }
  if (f.total && !/^no encontrad/i.test(f.total) && !RE_TOTAL.test(f.total)) {
    push("total", f.total, "formato inválido");
  }

  if (Array.isArray(f.lineas) && f.lineas.length > 0) {
    let suma = 0, ok = true;
    for (let i = 0; i < f.lineas.length; i++) {
      const l = f.lineas[i];
      for (const campo of ["unidades", "precio", "importe"]) {
        const v: string = l[campo];
        if (v && !RE_NUMERO.test(v)) push(`lineas[${i}].${campo}`, v, "formato numérico inválido");
      }
      const imp = parseNumeroES(l.importe);
      if (imp === null) ok = false;
      else suma += imp;
    }
    const total = parseNumeroES(f.total);
    if (ok && total !== null) {
      const baseEst = total / 1.21;
      const diff = Math.abs(suma - baseEst);
      if (diff > Math.max(5, baseEst * 0.05)) {
        push("lineas[suma]", `${suma.toFixed(2)} vs base est. ${baseEst.toFixed(2)}`,
             "suma de importes no cuadra con total/1.21");
      }
    }
  }
  return issues;
}

// ── 2) Re-extracción del PDF y comparación con mongo ──────────────────────────
async function reContrastar(f: any): Promise<{ diffs: DiffMongoVsActual[]; actual: DatosFactura | null }> {
  const ruta = join(CARPETA_PDFS, f.archivo);
  try {
    await access(ruta);
  } catch {
    return { diffs: [{ archivo: f.archivo, campo: "[pdf]", enMongo: "(existe en mongo)", reExtraido: "(no se encuentra el PDF)" }], actual: null };
  }

  // Re-extraemos con ambos métodos y combinamos (preferimos PDFJS si difieren)
  const [regex, pdfjs] = await Promise.all([
    extraerDatosFacturaRegex(ruta),
    extraerDatosFacturaPdfJs(ruta),
  ]);

  // Preferencia: pdfjs si lo encontró, si no regex
  const actual = pdfjs ?? regex;
  if (!actual) {
    return { diffs: [{ archivo: f.archivo, campo: "[extracción]", enMongo: "(ok)", reExtraido: "(ambos métodos fallaron)" }], actual: null };
  }

  const diffs: DiffMongoVsActual[] = [];
  const campos = ["nFactura", "fecha", "cliente", "telefono", "cifEmisor", "cifReceptor", "total"] as const;
  for (const c of campos) {
    const m = (f[c] ?? "").toString().trim();
    const a = ((actual as any)[c] ?? "").toString().trim();
    if (m !== a) diffs.push({ archivo: f.archivo, campo: c, enMongo: m, reExtraido: a });
  }
  const nLineasMongo  = Array.isArray(f.lineas) ? f.lineas.length : 0;
  const nLineasActual = actual.lineas?.length ?? 0;
  if (nLineasMongo !== nLineasActual) {
    diffs.push({ archivo: f.archivo, campo: "lineas[count]", enMongo: nLineasMongo, reExtraido: nLineasActual });
  }

  return { diffs, actual };
}

// ── Resúmenes ─────────────────────────────────────────────────────────────────
function resumenIssues(issues: Issue[], total: number) {
  const porCampo = new Map<string, number>();
  const porArchivo = new Map<string, number>();
  for (const i of issues) {
    porCampo.set(i.campo, (porCampo.get(i.campo) ?? 0) + 1);
    porArchivo.set(i.archivo, (porArchivo.get(i.archivo) ?? 0) + 1);
  }
  console.log("\n" + "═".repeat(60));
  console.log(`📊 VALIDACIÓN FORMATO: ${total} facturas, ${issues.length} issues`);
  console.log(`   ${porArchivo.size} archivos con incidencia`);
  console.log("═".repeat(60));
  console.log("\n📋 Por campo:");
  [...porCampo.entries()].sort((a, b) => b[1] - a[1]).forEach(([c, n]) =>
    console.log(`   ${c.padEnd(25)} ${n}`)
  );
  console.log("\n📂 Top 20 archivos:");
  [...porArchivo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([a, n]) =>
    console.log(`   ${a.padEnd(30)} ${n}`)
  );
}

function resumenDiffs(diffs: DiffMongoVsActual[]) {
  const porCampo = new Map<string, number>();
  const porArchivo = new Map<string, number>();
  for (const d of diffs) {
    porCampo.set(d.campo, (porCampo.get(d.campo) ?? 0) + 1);
    porArchivo.set(d.archivo, (porArchivo.get(d.archivo) ?? 0) + 1);
  }
  console.log("\n" + "═".repeat(60));
  console.log(`🔄 MONGO vs RE-EXTRACCIÓN: ${diffs.length} diferencias en ${porArchivo.size} archivos`);
  console.log("═".repeat(60));
  console.log("\n📋 Por campo:");
  [...porCampo.entries()].sort((a, b) => b[1] - a[1]).forEach(([c, n]) =>
    console.log(`   ${c.padEnd(25)} ${n}`)
  );
  console.log("\n🔍 Primeras 50 diferencias:");
  for (const d of diffs.slice(0, 50)) {
    console.log(`   ${d.archivo.padEnd(20)} ${d.campo.padEnd(20)}`);
    console.log(`      mongo:      ${JSON.stringify(d.enMongo)}`);
    console.log(`      re-extraido: ${JSON.stringify(d.reExtraido)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("⏳ Leyendo facturas de MongoDB...");
  const facturas = await obtenerTodasFacturas();
  console.log(`✅ ${facturas.length} facturas en mongo.\n`);

  // 1) Validación de formato sobre lo que ya está guardado
  const issues: Issue[] = [];
  for (const f of facturas) issues.push(...validarFormato(f));
  resumenIssues(issues, facturas.length);

  // 2) Re-extraer cada PDF y comparar con mongo
  console.log("\n⏳ Re-procesando PDFs y comparando con mongo...");
  const diffs: DiffMongoVsActual[] = [];
  const aActualizar: { archivo: string; mongo: number; nuevo: number; datos: DatosFactura }[] = [];
  for (let i = 0; i < facturas.length; i++) {
    const f = facturas[i];
    if (i % 25 === 0) console.log(`   [${i + 1}/${facturas.length}]`);
    const { diffs: d, actual } = await reContrastar(f);
    diffs.push(...d);

    // Solo si la re-extracción obtuvo MÁS líneas que las guardadas en mongo
    if (actual) {
      const nLineasMongo  = Array.isArray(f.lineas) ? f.lineas.length : 0;
      const nLineasActual = actual.lineas?.length ?? 0;
      if (nLineasActual > nLineasMongo) {
        aActualizar.push({ archivo: f.archivo, mongo: nLineasMongo, nuevo: nLineasActual, datos: actual });
      }
    }
  }
  resumenDiffs(diffs);

  // 3) Actualización selectiva: documentos con más líneas re-extraídas que en mongo
  if (aActualizar.length > 0) {
    console.log("\n" + "═".repeat(60));
    console.log(`✏️  ${aActualizar.length} archivo(s) con MÁS líneas re-extraídas → actualizando:`);
    console.log("═".repeat(60));
    for (const u of aActualizar) {
      console.log(`   ${u.archivo.padEnd(20)} mongo: ${u.mongo}  →  re-extraído: ${u.nuevo}`);
    }
    let ok = 0;
    for (const u of aActualizar) {
      try {
        await guardarFactura("RE_EXTRACTION", u.datos);
        ok++;
      } catch (e: any) {
        console.error(`   ⚠️  ${u.archivo}:`, e.message);
      }
    }
    console.log(`\n✅ ${ok}/${aActualizar.length} documento(s) actualizado(s).`);
  } else {
    console.log("\n✅ Ningún documento tiene más líneas en la re-extracción; no se actualiza nada.");
  }

  await cerrarConexion();
}

main().catch(e => {
  console.error("❌ Error:", e);
  process.exit(1);
});
