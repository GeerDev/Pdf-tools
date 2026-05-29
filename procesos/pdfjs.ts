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
    // Filas por página: necesarias para extraer la tabla de líneas de cada página
    // por separado en facturas multi-página (de lo contrario solo veríamos la primera).
    const filasPorPagina: Fila[][] = [];

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const pagina = await pdfDoc.getPage(i);
      const contenido = await pagina.getTextContent();

      const textoPagina = contenido.items.map((it: any) => it.str ?? "").join(" ");
      if (/es\s+copia/i.test(textoPagina)) continue;

      todosItems = todosItems.concat(contenido.items);
      filasPorPagina.push(agruparPorFila(contenido.items as any[]));

      // Región fija para el nombre del cliente (primera página válida)
      if (regionText === "") {
        const region = { x: 265, y: 755, width: 280, height: 70 };
        const regionItems = (contenido.items as any[])
          .filter((it: any) => {
            const tx: number = it.transform?.[4] ?? 0;
            const ty: number = it.transform?.[5] ?? 0;
            return (
              tx >= region.x && tx <= region.x + region.width &&
              ty >= region.y && ty <= region.y + region.height
            );
          })
          .sort((a: any, b: any) => b.transform[5] - a.transform[5]);

        // Agrupamos por fila (Y) de arriba a abajo y descartamos filas que sean
        // tipos de documento (FACTURA, ALBARÁN, ...) para quedarnos con el cliente.
        const filasY: number[] = [];
        for (const it of regionItems) {
          const y: number = it.transform[5];
          if (!filasY.some(fy => Math.abs(fy - y) <= 3)) filasY.push(y);
        }

        const tipoDocumento = /^(FACTURA(\s+SIMPLIFICADA)?|ALBAR[ÁA]N|PRESUPUESTO|TICKET|RECIBO|NOTA(\s+DE\s+ENTREGA)?)\s*$/i;

        for (const fy of filasY) {
          const texto = regionItems
            .filter((it: any) => Math.abs(it.transform[5] - fy) <= 3)
            .map((it: any) => it.str)
            .join("")
            .replace(/\s+/g, " ")
            .trim();
          if (!texto) continue;
          if (tipoDocumento.test(texto)) continue;
          regionText = texto;
          break;
        }
      }
    }

    // Deduplicar items por (str, x, y): en PDFs multi-página donde la cabecera
    // se repite idéntica, los items quedan duplicados al concatenar páginas y
    // rompen patrones como `fecha + nº factura` (la 2ª fecha se cuela entre medias).
    const vistos = new Set<string>();
    todosItems = todosItems.filter((it: any) => {
      if (!it.transform) return false;
      const key = `${it.str}|${it.transform[4].toFixed(1)}|${it.transform[5].toFixed(1)}`;
      if (vistos.has(key)) return false;
      vistos.add(key);
      return true;
    });

    const filas = agruparPorFila(todosItems);

    // ── Campos de cabecera: cada campo tiene su propio criterio de búsqueda ───

    let nFactura  = "No encontrado";
    let fecha     = "No encontrada";
    let telefono  = "No encontrado";
    let total     = "No encontrado";
    const cifsList: string[] = [];

    for (const fila of filas) {
      const joined = joinFila(fila);

      // Fecha + nFactura + Teléfono: todos vienen en la fila de la tabla de
      // cabecera (la que contiene la fecha DD/MM/YY). Buscamos el teléfono solo
      // ahí para no coger el de la cabecera DIECAR del emisor.
      if (fecha === "No encontrada") {
        const itemFecha = fila.items.find(i => /^\d{2}\/\d{2}\/\d{2,4}$/.test(i.str.trim()));
        if (itemFecha) {
          fecha = itemFecha.str.trim();
          // nFactura: mismo patrón que regex.ts pero aplicado solo a esta fila
          const textoFila = fila.items.map(i => i.str).join(" ").replace(/\s+/g, " ");
          const mNF = textoFila.match(/\d{2}\/\d{2}\/\d{2,4}\s+([A-Z][A-Z\s]*\d+)/);
          if (mNF?.[1]) nFactura = mNF[1].replace(/\s+/g, " ").trim();

          // Teléfono: 9 dígitos, en un item suelto (con o sin espacios internos),
          // o partido en items consecutivos 3-3-3 o 3-2-2-2.
          const tel = fila.items.find(i => /^\d{9}(?:[-A-Z][\w-]*)?$/.test(i.str.trim().replace(/\s+/g, "")));
          if (tel) {
            const limpio = tel.str.trim().replace(/\s+/g, "");
            telefono = limpio.match(/^\d{9}/)![0];
          } else {
            const its = fila.items.map(i => i.str.trim()).filter(s => s);
            for (let i = 0; i <= its.length - 3; i++) {
              if (/^\d{3}$/.test(its[i] ?? "") && /^\d{3}$/.test(its[i+1] ?? "") && /^\d{3}$/.test(its[i+2] ?? "")) {
                telefono = (its[i] ?? "") + (its[i+1] ?? "") + (its[i+2] ?? "");
                break;
              }
            }
            if (telefono === "No encontrado") {
              for (let i = 0; i <= its.length - 4; i++) {
                if (/^\d{3}$/.test(its[i] ?? "") && /^\d{2}$/.test(its[i+1] ?? "") && /^\d{2}$/.test(its[i+2] ?? "") && /^\d{2}$/.test(its[i+3] ?? "")) {
                  telefono = (its[i] ?? "") + (its[i+1] ?? "") + (its[i+2] ?? "") + (its[i+3] ?? "");
                  break;
                }
              }
            }
          }
        }
      }

      // CIFs: items individuales con formato CIF empresa (A12345678), NIF persona
      // física (12345678Z), NIE (X8465435D), NIF corto (F6340642) o con guiones.
      for (const item of fila.items) {
        const s = item.str.trim();
        if (/^(?:[A-Z]\d{9}|[A-Z]\d{8}|[A-Z]\d{7}[A-Z]|[A-Z]\d{7}|\d{8}[A-Z]|[A-Z]-\d{8}-\d|[A-Z]-\d{8})$/.test(s) && !cifsList.includes(s)) {
          cifsList.push(s);
        }
      }

      // Total: acumulamos el último importe seguido de € (el más bajo en la página)
      const mTotal = joined.match(/(-?[\d.,]+)\s*€/);
      if (mTotal) total = mTotal[0].replace(/\s+/g, " ").trim();
    }

    // Fallback total: si el importe y el € caen en filas distintas (p.ej. layouts
    // donde el € sale en línea aparte), buscamos en el texto global concatenado
    // y nos quedamos con el último match (el total siempre está al final).
    if (total === "No encontrado") {
      const todoTexto = todosItems.map((it: any) => it.str ?? "").join(" ");
      const matches = [...todoTexto.matchAll(/(-?[\d.,]+)\s*€/g)];
      if (matches.length > 0) total = matches[matches.length - 1]![0].replace(/\s+/g, " ").trim();
    }

    // Fallback nFactura: en algunos layouts la fecha y el número de factura
    // quedan en filas distintas por pequeñas diferencias de Y, y la búsqueda
    // por fila no captura el número. Buscamos en el texto global.
    if (nFactura === "No encontrado") {
      const todoTexto = todosItems.map((it: any) => it.str ?? "").join(" ");
      const mNF = todoTexto.match(/\d{2}\/\d{2}\/\d{2,4}\s+([A-Z][A-Z\s]*\d+)/);
      if (mNF?.[1]) nFactura = mNF[1].replace(/\s+/g, " ").trim();
    }

    const cifEmisor  = cifsList[0] ?? "No encontrado";
    const cifReceptor = cifsList[1] ?? "No encontrado";

    // ── Tabla de líneas: mapeo geométrico X → columna, página a página ───────
    // En facturas multi-página, cada página tiene su propio CÓDIGO ... TOTAL IMP,
    // así que iteramos las filas de cada página por separado y acumulamos.
    const lineas: Array<{
      codigo: string; descripcion: string; unidades: string;
      precio: string; dto1: string; dto2: string; importe: string;
    }> = [];

    for (const filasPagina of filasPorPagina) {
      const iCab = filasPagina.findIndex(f => /C.DIGO/i.test(joinFila(f)));
      const iFin = filasPagina.findIndex(f => /TOTAL\s*IMP/i.test(joinFila(f)));
      if (iCab < 0 || iFin <= iCab) continue;

      // Detectar columnas desde los items del header agrupando por proximidad en X.
      const cabItems = filasPagina[iCab]!.items.filter(i => i.str.trim());
      const clusters: { x: number }[] = [];
      for (const item of cabItems) {
        if (!clusters.some(c => Math.abs(c.x - item.x) < 15))
          clusters.push({ x: item.x });
      }
      clusters.sort((a, b) => a.x - b.x);

      const colBounds = clusters.map((c, idx) => ({
        xMin: idx === 0 ? -Infinity : (clusters[idx - 1]!.x + c.x) / 2,
        xMax: idx === clusters.length - 1 ? Infinity : (c.x + clusters[idx + 1]!.x) / 2,
      }));

      const mapCol = (x: number) => colBounds.findIndex(c => x >= c.xMin && x < c.xMax);

      for (const fila of filasPagina.slice(iCab + 1, iFin)) {
        const celdas: string[] = new Array(clusters.length).fill("");
        for (const item of fila.items) {
          if (!item.str.trim()) continue;
          const col = mapCol(item.x);
          if (col >= 0) celdas[col] = (celdas[col] + " " + item.str).trim();
        }

        // Si la columna de unidades trae texto pegado al número (descripción que
        // se cuela por ser más ancha que la columna, p.ej. "READY 125cm3 14,00"),
        // movemos el texto a la descripción y dejamos solo el número en unidades.
        const u = celdas[2] ?? "";
        if (u && !/^-?\d+,\d+$/.test(u)) {
          const m = u.match(/(-?\d+,\d+)\s*$/);
          if (m) {
            const extra = u.slice(0, u.length - m[0].length).trim();
            if (extra) celdas[1] = ((celdas[1] ?? "") + " " + extra).trim();
            celdas[2] = m[1]!;
          }
        }

        const c = celdas[0] ?? "";
        if (c !== "") {
          // Con código: mayúsculas (incluyendo Ñ y vocales con tilde) + chars
          // típicos (`, ., /, -, ,) en un único token, con opcional sufijo
          // separado por espacio para códigos de dos partes tipo "AESR60 M1".
          // Si no lleva dígitos, exigimos unidades numéricas para descartar
          // rótulos sueltos como "MOSTRADOR".
          if (!/^[A-ZÁÉÍÓÚÑÜÇ]{2,}[A-ZÁÉÍÓÚÑÜÇ0-9`,/.-]*(?:\s+[A-ZÁÉÍÓÚÑÜÇ0-9`,/.-]+)*$/.test(c)) continue;
          if (!/\d/.test(c) && !/^-?\d+,\d+$/.test(celdas[2] ?? "")) continue;
        } else {
          // Sin código (filas tipo "PORTES" donde sólo hay descripción + importes).
          // Requerimos descripción que empiece por 2+ mayúsculas y unidades
          // numéricas, así descartamos filas descriptivas (ALBARÁN, PEDIDO...).
          const d = (celdas[1] ?? "").trim();
          if (!/^[A-Z]{2,}/.test(d)) continue;
          if (!/^-?\d+,\d+$/.test(celdas[2] ?? "")) continue;
        }

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
      cliente:      regionText.replace(/\s+/g, " ").trim() || "No encontrado",
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
