import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { extraerDatosFacturaRegex, type DatosFactura } from "./procesos/regex";
import { extraerDatosFacturaIA } from "./procesos/ia";
import { extraerDatosFacturaPdfJs } from "./procesos/pdfjs";
import { guardarFactura, cerrarConexion } from "./procesos/mongo";
import { exportarExcel } from "./procesos/excel";

const CARPETA_PDFS = "./pdfs";

function compararResultados(resultados: { label: string; datos: DatosFactura }[], archivo?: string): boolean {
  const activos = resultados.filter(r => r.datos != null);
  if (activos.length < 2) return false;

  const campos = ["nFactura", "fecha", "cliente", "telefono", "cifEmisor", "cifReceptor", "total"] as const;
  const diferencias: string[] = [];

  for (const campo of campos) {
    const valores = activos.map(r => ({ label: r.label, val: (r.datos![campo] as string)?.trim() }));
    const todos = valores.map(v => v.val);
    const hayDiferencia = todos.some(v => v !== todos[0]);
    if (hayDiferencia) {
      const resumen = valores.map(v => `${v.label}: "${v.val}"`).join("  ");
      diferencias.push(`  ${campo.padEnd(14)} ${resumen}`);
    }
  }

  const numLineas = activos.map(r => r.datos!.lineas.length);
  if (numLineas.some(n => n !== numLineas[0])) {
    const resumen = activos.map(r => `${r.label}: ${r.datos!.lineas.length}`).join("  ");
    diferencias.push(`  lineas         ${resumen}`);
  }

  if (diferencias.length === 0) {
    return false;
  } else {
    console.log(`  ⚠️  ${diferencias.length} diferencia(s)${archivo ? ` en ${archivo}` : ""}:`);
    for (const d of diferencias) console.log(d);
    return true;
  }
}

function mostrarBloque(label: string, emoji: string, datos: DatosFactura[]) {
  console.log("\n" + "═".repeat(50));
  console.log(`${emoji} RESULTADOS ${label}`);
  console.log("═".repeat(50));
  for (const r of datos) {
    if (!r) continue;
    console.log("─".repeat(50));
    console.log(`📄 Archivo:      ${r.archivo}`);
    console.log(`🔢 Nº Factura:   ${r.nFactura}`);
    console.log(`📅 Fecha:        ${r.fecha}`);
    console.log(`🙍‍♂️ Cliente:      ${r.cliente}`);
    console.log(`📞 Teléfono:     ${r.telefono}`);
    console.log(`🏢 CIF Emisor:   ${r.cifEmisor}`);
    console.log(`🏢 CIF Receptor: ${r.cifReceptor}`);
    console.log(`💶 Total:        ${r.total}`);
    if (r.lineas.length > 0) {
      console.log(`📦 Líneas:`);
      for (const l of r.lineas) {
        console.log(`   ${l.codigo.padEnd(15)} ${l.descripcion.padEnd(30)} x${l.unidades}  ${l.precio}€  DTO1:${l.dto1}%  DTO2:${l.dto2}%  → ${l.importe}€`);
      }
    }
  }
  console.log("─".repeat(50));
}

async function procesarCarpeta() {
  try {
    const archivos = await readdir(CARPETA_PDFS);
    const archivosPdf = archivos.filter(f => f.toLowerCase().endsWith(".pdf"));

    console.log(`✨ Procesando ${archivosPdf.length} PDFs... (REGEX + PDFJS)\n`);

    // ── Fase 1: extracción REGEX + PDFJS para todos los archivos ─────────────
    const resultados: { archivo: string; ruta: string; regex: DatosFactura; pdfjs: DatosFactura; ia: DatosFactura }[] = [];

    for (let i = 0; i < archivosPdf.length; i++) {
      const archivo = archivosPdf[i]!;
      console.log(`⏳ [${i + 1}/${archivosPdf.length}] Procesando: ${archivo}`);
      const ruta = join(CARPETA_PDFS, archivo);
      const datosRegex = await extraerDatosFacturaRegex(ruta);
      const datosPdfJs = await extraerDatosFacturaPdfJs(ruta);
      resultados.push({ archivo, ruta, regex: datosRegex, pdfjs: datosPdfJs, ia: null });
    }

    // mostrarBloque("REGEX", "📊", resultados.map(r => r.regex));
    // mostrarBloque("PDFJS", "📑", resultados.map(r => r.pdfjs));

    // ── Comparación REGEX vs PDFJS ────────────────────────────────────────────
    const archivosConDiferencias: string[] = [];

    console.log("\n" + "═".repeat(50));
    console.log("🔍 COMPARACIÓN  (REGEX vs PDFJS)");
    console.log("═".repeat(50));
    for (const r of resultados) {
      const hayDif = compararResultados([
        { label: "REGEX", datos: r.regex },
        { label: "PDFJS", datos: r.pdfjs },
      ], r.archivo);
      if (hayDif) archivosConDiferencias.push(r.archivo);
    }

    // ── Resumen fase 1 ────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(50));
    if (archivosConDiferencias.length === 0) {
      console.log("✅ RESUMEN: todos los archivos coinciden entre REGEX y PDFJS");
      console.log("═".repeat(50));
      for (const r of resultados) {
        await guardarFactura("PDF_EXTRACTION", r.pdfjs).catch(e => console.error("⚠️  Mongo:", e.message));
      }
      return;
    }

    console.log(`⚠️  RESUMEN: ${archivosConDiferencias.length} archivo(s) con diferencias:`);
    for (const nombre of archivosConDiferencias) console.log(`   • ${nombre}`);
    console.log("═".repeat(50));

    const respuesta = prompt("\n¿Analizar estos archivos con Gemini AI? (s/n): ")?.trim().toLowerCase();
    if (respuesta !== "s") {
      for (const r of resultados) {
        await guardarFactura("PDF_EXTRACTION", r.regex).catch(e => console.error("⚠️  Mongo:", e.message));
      }
      console.log("⏭️  Análisis con IA omitido.");
      return;
    }

    // Guardar como PDF_EXTRACTION los archivos sin diferencias antes de continuar con IA
    for (const r of resultados.filter(r => !archivosConDiferencias.includes(r.archivo))) {
      await guardarFactura("PDF_EXTRACTION", r.regex).catch(e => console.error("⚠️  Mongo:", e.message));
    }

    // ── Fase 2: Gemini AI solo para los archivos con diferencias ─────────────
    console.log(`\n🤖 Analizando ${archivosConDiferencias.length} archivo(s) con Gemini AI...\n`);

    for (const r of resultados.filter(r => archivosConDiferencias.includes(r.archivo))) {
      console.log(`⏳ IA procesando: ${r.archivo}`);
      r.ia = await extraerDatosFacturaIA(r.ruta);
      if (r.ia) await guardarFactura("IA_EXTRACTION", r.ia).catch(e => console.error("⚠️  Mongo IA:", e.message));
    }

    mostrarBloque("IA (Gemini)", "🤖", resultados.filter(r => r.ia).map(r => r.ia));

    // ── Comparación 3-way solo para los archivos con diferencias ─────────────
    console.log("\n" + "═".repeat(50));
    console.log("🔍 COMPARACIÓN 3-WAY  (REGEX vs PDFJS vs GEMINI)");
    console.log("═".repeat(50));
    for (const r of resultados.filter(r => archivosConDiferencias.includes(r.archivo))) {
      console.log(`\n📄 ${r.archivo}`);
      compararResultados([
        { label: "REGEX",  datos: r.regex },
        { label: "PDFJS",  datos: r.pdfjs },
        { label: "GEMINI", datos: r.ia },
      ]);
    }
    console.log("═".repeat(50));

  } catch (error) {
    console.error("❌ Error en el proceso:", error);
  } finally {
    await cerrarConexion();
  }
}

procesarCarpeta().then(async () => {
  const resp = prompt("\n¿Exportar todos los datos de MongoDB a Excel? (s/n): ")?.trim().toLowerCase();
  if (resp !== "s") return;

  console.log("📊 Generando Excel...");
  try {
    const ruta = await exportarExcel();
    if (ruta) console.log(`✅ Excel guardado en: ${ruta}`);
  } catch (e: any) {
    console.error("❌ Error al generar Excel:", e.message);
  } finally {
    await cerrarConexion();
  }
});