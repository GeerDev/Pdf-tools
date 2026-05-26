import { basename } from "node:path";
import { PDF } from "@libpdf/core";

export async function extraerDatosFacturaRegex(rutaArchivo: string) {
  try {
    const fileBuffer = await Bun.file(rutaArchivo).arrayBuffer();
    const pdf = await PDF.load(new Uint8Array(fileBuffer));
    const paginas = pdf.getPages();

    if (paginas.length === 0) return null;

    let textoCompleto = "";
    let regionText = "";

    for (const pagina of paginas) {
      const lineasTexto = await pagina.extractText();
      if (/Es copia/i.test(lineasTexto.text)) continue;

      const { lines } = pagina.extractText();

      const region = { x: 270, y: 785, width: 260, height: 20 };
      const inRegion = lines.filter(line =>
          line.bbox.x >= region.x &&
          line.bbox.x + line.bbox.width <= region.x + region.width &&
          line.bbox.y >= region.y &&
          line.bbox.y + line.bbox.height <= region.y + region.height,
      );
      regionText = inRegion.map(line => line.text).join(" ");

      textoCompleto += lineasTexto.text + " ";
    }

    const regexFactura = /\d{2}\/\d{2}\/\d{2,4}\s+([A-Z]\s?\d+)/;
    const regexFecha = /\d{2}\/\d{2}\/\d{2,4}/;
    const regexTotal = /([\d,]+)\s*€/;
    const regexCIF = /[A-Z]\d{8}/;
    const regexTelefono = /\d{2}\/\d{2}\/\d{2,4}\s+[A-Z]\s?\d+\s+\d+\s+[A-Z]\d{8}\s+(\d{9})/;

    const nFactura = textoCompleto.match(regexFactura)?.[1] || "No encontrado";
    const fecha = textoCompleto.match(regexFecha)?.[0] || "No encontrada";
    const total = textoCompleto.match(regexTotal)?.[0] || "No encontrado";
    const cifs = textoCompleto.match(new RegExp(regexCIF, "g")) || [];
    const cifEmisor = cifs[0] || "No encontrado";
    const cifReceptor = cifs[1] || "No encontrado";
    const telefono = textoCompleto.match(regexTelefono)?.[1] || "No encontrado";
    const cliente = regionText;

    const seccionLineas = textoCompleto.match(/C.DIGO[\s\S]+?(?=TOTAL\s+IMP)/i)?.[0] ?? textoCompleto;

    const regexLinea = /([A-Z]{2,}\d+[A-Z0-9\/-]*)\s+(.+?)\s+(\d+,\d+)\s+(\d+,\d+)(?:\s+(\d+,\d+))?(?:\s+(\d+,\d+))?(?:\s+(\d+,\d+))?/g;
    const lineas = [...seccionLineas.matchAll(regexLinea)].map(m => {
      const nums = [m[3], m[4], m[5], m[6], m[7]].filter((v): v is string => v !== undefined);
      return {
        codigo: m[1] ?? "",
        descripcion: m[2] ?? "",
        unidades: nums[0] ?? "",
        precio: nums[1] ?? "",
        dto1: nums.length >= 4 ? (nums[2] ?? "-") : "-",
        dto2: nums.length >= 5 ? (nums[3] ?? "-") : "-",
        importe: nums.length >= 3 ? (nums[nums.length - 1] ?? "") : "",
      };
    });

    return {
      archivo: basename(rutaArchivo),
      nFactura,
      fecha,
      cliente,
      telefono,
      cifEmisor,
      cifReceptor,
      total,
      lineas,
    };
  } catch (error) {
    const mensajeError = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error en archivo ${rutaArchivo}:`, mensajeError);
    return null;
  }
}

export type DatosFactura = Awaited<ReturnType<typeof extraerDatosFacturaRegex>>;
