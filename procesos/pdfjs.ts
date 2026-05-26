import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DatosFactura } from "./regex";

GlobalWorkerOptions.workerSrc = import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");

// ── Tipos internos ────────────────────────────────────────────────────────────

interface Item { str: string; x: number; y: number; }
interface Fila { y: number; items: Item[]; }

// ── Helpers espaciales ────────────────────────────────────────────────────────

/** Agrupa items de texto por fila según coordenada Y (tolerancia en px) */
function agruparPorFila(rawItems: any[], tolerancia = 3): Fila[] {
  const filas: Fila[] = [];
  for (const raw of rawItems) {
    if (!("transform" in raw)) continue;
    const str: string = raw.str ?? "";
    const x: number = raw.transform[4];
    const y: number = raw.transform[5];
    const fila = filas.find(f => Math.abs(f.y - y) <= tolerancia);
    if (fila) fila.items.push({ str, x, y });
    else filas.push({ y, items: [{ str, x, y }] });
  }
  // Ordenar filas de arriba a abajo (Y mayor = más arriba en PDF)
  filas.sort((a, b) => b.y - a.y);
  // Ordenar items dentro de cada fila de izquierda a derecha
  for (const f of filas) f.items.sort((a, b) => a.x - b.x);
  return filas;
}

/** Concatena los strings de una fila (sin separador, trimmeados) */
function joinFila(fila: Fila): string {
  return fila.items.map(i => i.str.trim()).join("");
}

// ── Extractor principal ───────────────────────────────────────────────────────

export async function extraerDatosFacturaPdfJs(rutaArchivo: string): Promise<DatosFactura> {
  try {
    const buffer = await readFile(rutaArchivo);
    const loadingTask = getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
    const pdfDoc = await loadingTask.promise;

    let todosItems: any[] = [];
    let regionText = "";

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const pagina = await pdfDoc.getPage(i);
      const contenido = await pagina.getTextContent();

      const textoPagina = contenido.items.map((it: any) => it.str ?? "").join(" ");
      if (/es\s+copia/i.test(textoPagina)) continue;

      todosItems = todosItems.concat(contenido.items);

      // Región fija para el nombre del cliente (primera página válida)
      if (regionText === "") {
        const region = { x: 270, y: 785, width: 260, height: 20 };
        regionText = contenido.items
          .filter((it: any) => {
            const tx: number = it.transform?.[4] ?? 0;
            const ty: number = it.transform?.[5] ?? 0;
            return (
              tx >= region.x && tx <= region.x + region.width &&
              ty >= region.y && ty <= region.y + region.height
            );
          })
          .map((it: any) => it.str)
          .join("")
          .replace(/\s+/g, " ")
          .trim();
      }
    }

    const filas = agruparPorFila(todosItems);

    // ── Campos de cabecera: cada campo tiene su propio criterio de búsqueda ───

    let nFactura  = "No encontrado";
    let fecha     = "No encontrada";
    let telefono  = "No encontrado";
    let total     = "No encontrado";
    const cifsList: string[] = [];

    for (const fila of filas) {
      const joined = joinFila(fila);

      // Fecha: fila que contiene un item con formato DD/MM/YY(YY)
      if (fecha === "No encontrada") {
        const itemFecha = fila.items.find(i => /^\d{2}\/\d{2}\/\d{2,4}$/.test(i.str.trim()));
        if (itemFecha) {
          fecha = itemFecha.str.trim();
          // nFactura: mismo patrón que regex.ts pero aplicado solo a esta fila
          const textoFila = fila.items.map(i => i.str).join(" ").replace(/\s+/g, " ");
          const mNF = textoFila.match(/\d{2}\/\d{2}\/\d{2,4}\s+([A-Z]\s?\d+)/);
          if (mNF?.[1]) nFactura = mNF[1];
        }
      }

      // CIFs: items individuales que sean exactamente letra + 8 dígitos
      for (const item of fila.items) {
        const s = item.str.trim();
        if (/^[A-Z]\d{8}$/.test(s) && !cifsList.includes(s)) cifsList.push(s);
      }

      // Teléfono: item individual de exactamente 9 dígitos
      if (telefono === "No encontrado") {
        const tel = fila.items.find(i => /^\d{9}$/.test(i.str.trim()));
        if (tel) telefono = tel.str.trim();
      }

      // Total: acumulamos el último importe seguido de € (el más bajo en la página)
      const mTotal = joined.match(/([\d.,]+)€/);
      if (mTotal) total = mTotal[0];
    }

    const cifEmisor  = cifsList[0] ?? "No encontrado";
    const cifReceptor = cifsList[1] ?? "No encontrado";

    // ── Tabla de líneas: mapeo geométrico X → columna ────────────────────────
    // iCab/iFin: buscar en el texto unido de cada fila (robusto aunque pdfjs
    // fragmente "TOTAL" e "IMP." en items separados o parta "CÓDIGO")
    const iCab = filas.findIndex(f => /C.DIGO/i.test(joinFila(f)));
    const iFin = filas.findIndex(f => /TOTAL\s*IMP/i.test(joinFila(f)));

    const lineas: Array<{
      codigo: string; descripcion: string; unidades: string;
      precio: string; dto1: string; dto2: string; importe: string;
    }> = [];

    if (iCab >= 0 && iFin > iCab) {
      // Detectar columnas desde los items del header agrupando por proximidad en X.
      // Tolerancia 15 px: une caracteres de la misma palabra sin fusionar columnas distintas.
      const cabItems = filas[iCab]!.items.filter(i => i.str.trim());
      const clusters: { x: number }[] = [];
      for (const item of cabItems) {
        if (!clusters.some(c => Math.abs(c.x - item.x) < 15))
          clusters.push({ x: item.x });
      }
      clusters.sort((a, b) => a.x - b.x);

      // Límites de columna: midpoint entre anchors consecutivos
      const colBounds = clusters.map((c, idx) => ({
        xMin: idx === 0 ? -Infinity : (clusters[idx - 1]!.x + c.x) / 2,
        xMax: idx === clusters.length - 1 ? Infinity : (c.x + clusters[idx + 1]!.x) / 2,
      }));

      const mapCol = (x: number) => colBounds.findIndex(c => x >= c.xMin && x < c.xMax);

      for (const fila of filas.slice(iCab + 1, iFin)) {
        // Asignar cada item a su columna únicamente por coordenada X
        const celdas: string[] = new Array(clusters.length).fill("");
        for (const item of fila.items) {
          if (!item.str.trim()) continue;
          const col = mapCol(item.x);
          if (col >= 0) celdas[col] = (celdas[col] + " " + item.str).trim();
        }

        // Col 0 = CÓDIGO (columna más a la izquierda)
        if (!/^[A-Z]{2,}\d+/.test(celdas[0] ?? "")) continue;

        // Índices fijos: 0=código 1=descripción 2=unidades 3=precio 4=dto1 5=dto2 última=importe
        lineas.push({
          codigo:      celdas[0] ?? "",
          descripcion: celdas[1] ?? "",
          unidades:    celdas[2] ?? "",
          precio:      celdas[3] ?? "",
          dto1:        celdas[4] || "-",
          dto2:        celdas[5] || "-",
          importe:     celdas[celdas.length - 1] ?? "",
        });
      }
    }

    return {
      archivo:      basename(rutaArchivo),
      nFactura,
      fecha,
      cliente:      regionText || "No encontrado",
      telefono,
      cifEmisor,
      cifReceptor,
      total,
      lineas,
    };
  } catch (error) {
    const mensajeError = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error PdfJs en archivo ${rutaArchivo}:`, mensajeError);
    return null;
  }
}
