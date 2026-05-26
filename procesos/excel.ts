import ExcelJS from "exceljs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { obtenerTodasFacturas } from "./mongo";

const CABECERA_FACTURAS = [
  { header: "Archivo",      key: "archivo",      width: 30 },
  { header: "Nº Factura",   key: "nFactura",     width: 14 },
  { header: "Fecha",        key: "fecha",         width: 12 },
  { header: "Cliente",      key: "cliente",       width: 35 },
  { header: "Teléfono",     key: "telefono",      width: 14 },
  { header: "CIF Emisor",   key: "cifEmisor",     width: 14 },
  { header: "CIF Receptor", key: "cifReceptor",   width: 14 },
  { header: "Total",        key: "total",         width: 12 },
  { header: "Método",       key: "metodo",        width: 16 },
  { header: "Actualizado",  key: "actualizadoEn", width: 22 },
];

const CABECERA_LINEAS = [
  { header: "Archivo",     key: "archivo",     width: 30 },
  { header: "Nº Factura",  key: "nFactura",    width: 14 },
  { header: "Código",      key: "codigo",      width: 18 },
  { header: "Descripción", key: "descripcion", width: 40 },
  { header: "Unidades",    key: "unidades",    width: 10 },
  { header: "Precio",      key: "precio",      width: 10 },
  { header: "DTO1 %",      key: "dto1",        width: 8  },
  { header: "DTO2 %",      key: "dto2",        width: 8  },
  { header: "Importe",     key: "importe",     width: 12 },
];

function estilarCabecera(ws: ExcelJS.Worksheet) {
  const fila = ws.getRow(1);
  fila.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2E4057" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FF000000" } },
    };
  });
  fila.height = 20;
}

export async function exportarExcel(carpetaSalida = "./excels"): Promise<string> {
  const facturas = await obtenerTodasFacturas();

  if (facturas.length === 0) {
    console.log("ℹ️  No hay datos en MongoDB para exportar.");
    return "";
  }

  await mkdir(carpetaSalida, { recursive: true });

  const wb = new ExcelJS.Workbook();
  wb.creator = "pdf-tools";
  wb.created  = new Date();

  // ── Hoja 1: Facturas ────────────────────────────────────────────────────────
  const wsFacturas = wb.addWorksheet("Facturas");
  wsFacturas.columns = CABECERA_FACTURAS;
  estilarCabecera(wsFacturas);

  for (const f of facturas) {
    wsFacturas.addRow({
      archivo:      f.archivo      ?? "",
      nFactura:     f.nFactura     ?? "",
      fecha:        f.fecha        ?? "",
      cliente:      f.cliente      ?? "",
      telefono:     f.telefono     ?? "",
      cifEmisor:    f.cifEmisor    ?? "",
      cifReceptor:  f.cifReceptor  ?? "",
      total:        f.total        ?? "",
      metodo:       f.metodo       ?? "",
      actualizadoEn: f.actualizadoEn
        ? new Date(f.actualizadoEn).toLocaleString("es-ES")
        : "",
    });
  }

  // Filas alternas
  wsFacturas.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell(cell => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: rowNumber % 2 === 0 ? "FFF5F5F5" : "FFFFFFFF" },
      };
    });
  });

  // ── Hoja 2: Líneas ──────────────────────────────────────────────────────────
  const wsLineas = wb.addWorksheet("Líneas");
  wsLineas.columns = CABECERA_LINEAS;
  estilarCabecera(wsLineas);

  for (const f of facturas) {
    for (const l of (f.lineas ?? [])) {
      wsLineas.addRow({
        archivo:     f.archivo    ?? "",
        nFactura:    f.nFactura   ?? "",
        codigo:      l.codigo     ?? "",
        descripcion: l.descripcion ?? "",
        unidades:    l.unidades   ?? "",
        precio:      l.precio     ?? "",
        dto1:        l.dto1       ?? "",
        dto2:        l.dto2       ?? "",
        importe:     l.importe    ?? "",
      });
    }
  }

  wsLineas.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell(cell => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: rowNumber % 2 === 0 ? "FFF5F5F5" : "FFFFFFFF" },
      };
    });
  });

  // ── Guardar ─────────────────────────────────────────────────────────────────
  const fecha = new Date().toISOString().slice(0, 10);
  const nombreArchivo = `facturas_${fecha}.xlsx`;
  const rutaSalida = join(carpetaSalida, nombreArchivo);
  await wb.xlsx.writeFile(rutaSalida);

  return rutaSalida;
}
