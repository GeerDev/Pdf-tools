import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { DatosFactura } from "./regex";

const MODELO = "gemini-2.5-flash";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PROMPT_FACTURA = `Analiza este PDF de factura y extrae los datos en formato JSON estricto (sin markdown, solo JSON puro):
{
  "nFactura": "código de factura (ejemplo: A 23242)",
  "fecha": "fecha en formato DD/MM/AA",
  "cliente": "nombre de la empresa cliente",
  "telefono": "teléfono del cliente (9 dígitos sin espacios)",
  "cifEmisor": "CIF del emisor (letra + 8 dígitos)",
  "cifReceptor": "CIF del receptor (letra + 8 dígitos)",
  "total": "importe total con símbolo €",
  "lineas": [
    { "codigo": "", "descripcion": "", "unidades": "", "precio": "", "dto1": "", "dto2": "-", "importe": "" }
  ]
}`;

export async function extraerDatosFacturaIA(rutaArchivo: string): Promise<DatosFactura> {
  try {
    const pdfBuffer = await readFile(rutaArchivo);
    const response = await ai.models.generateContent({
      model: MODELO,
      contents: [{
        role: "user",
        parts: [
          { text: PROMPT_FACTURA },
          { inlineData: { data: pdfBuffer.toString("base64"), mimeType: "application/pdf" } },
        ],
      }],
    });

    const texto = response.text?.trim() ?? "{}";
    const json = JSON.parse(texto.replace(/^```json\s*/i, "").replace(/```\s*$/, ""));

    return {
      archivo: basename(rutaArchivo),
      nFactura: json.nFactura ?? "No encontrado",
      fecha: json.fecha ?? "No encontrada",
      cliente: json.cliente ?? "No encontrado",
      telefono: json.telefono ?? "No encontrado",
      cifEmisor: json.cifEmisor ?? "No encontrado",
      cifReceptor: json.cifReceptor ?? "No encontrado",
      total: json.total ?? "No encontrado",
      lineas: json.lineas ?? [],
    };
  } catch (error: any) {
    if (error.status === 429 || error.message?.includes("429")) {
      console.warn(`⚠️  Rate limit al procesar ${basename(rutaArchivo)}, esperando 60s...`);
      await delay(60000);
      return extraerDatosFacturaIA(rutaArchivo);
    }
    console.error(`❌ Error IA en ${basename(rutaArchivo)}:`, error.message);
    return null;
  }
}
