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

      // 1) Búsqueda por región (coordenadas desde abajo-izquierda en @libpdf/core).
      //    Mayor Y = más arriba en la página → ordenamos descendente para coger
      //    la línea superior del box del cliente.
      if (!regionText) {
        const region = { x: 265, y: 755, width: 280, height: 70 };
        // Sólo exigimos que el borde izquierdo esté en la columna derecha; si la
        // línea es muy ancha y sobresale, igual nos sirve (p.ej. nombres largos
        // tipo "SAMBEAT MANUFACTURING SOLUTIONS, S.L.").
        const inRegion = lines.filter(line =>
          line.bbox.x >= region.x &&
          line.bbox.x <= region.x + region.width &&
          line.bbox.y >= region.y &&
          line.bbox.y + line.bbox.height <= region.y + region.height,
        );
        const candidato = inRegion
          .filter(l => l.text.trim().length >= 2)
          .sort((a, b) => b.bbox.y - a.bbox.y)[0];
        if (candidato) regionText = candidato.text.trim();
      }

      // 2) Fallback: en algunos PDFs @libpdf/core concatena emisor (DIECAR) y
      //    cliente en la misma línea de cabecera. Quitamos el emisor y nos
      //    quedamos con el cliente.
      if (!regionText) {
        const lineaCabecera = lines.find(l => /DIECAR/i.test(l.text));
        if (lineaCabecera) {
          const cliente = lineaCabecera.text
            .replace(/^.*?DIECAR\s+ASOCIADOS\s+S\.?L\.?U?\.?\s+/i, "")
            .trim();
          if (cliente) regionText = cliente;
        }
      }

      textoCompleto += lineasTexto.text + " ";
    }

    const regexFactura = /\d{2}\/\d{2}\/\d{2,4}\s+([A-Z][A-Z\s]*\d+)/;
    const regexFecha = /\d{2}\/\d{2}\/\d{2,4}/;
    const regexTotal = /(-?[\d.,]+)\s*€/;
    const regexCIF = /\b(?:[A-Z]-\d{8}-\d|[A-Z]-\d{8}|[A-Z]\d{9}|[A-Z]\d{8}|[A-Z]\d{7}[A-Z]|[A-Z]\d{7}|\d{8}[A-Z])/;
    // Teléfono: 3 formatos posibles, todos de exactamente 9 dígitos.
    // - 9 dígitos seguidos (961661626)
    // - 3-3-3 con espacios   (963 843 300)
    // - 3-2-2-2 con espacios (649 02 93 51)
    const regexTelefono = /\d{2}\/\d{2}\/\d{2,4}\s+[A-Z][A-Z\s]*\d+\s+\d+\s+(?:[A-Z]-\d{8}-\d|[A-Z]-\d{8}|[A-Z]\d{9}|[A-Z]\d{8}|[A-Z]\d{7}[A-Z]|[A-Z]\d{7}|\d{8}[A-Z])(?:\s+\d{1,8})*\s+(\d{9}|\d{3}\s\d{3}\s\d{3}|\d{3}\s\d{2}\s\d{2}\s\d{2})/;

    const nFactura = textoCompleto.match(regexFactura)?.[1]?.replace(/\s+/g, " ").trim() || "No encontrado";
    const fecha = textoCompleto.match(regexFecha)?.[0] || "No encontrada";
    // Cogemos el ÚLTIMO match: si en la descripción hay un importe con €
    // (p.ej. "HEMOS AÑADIDO ... DE 4,94 €"), el real total siempre está al final.
    const todosTotales = [...textoCompleto.matchAll(new RegExp(regexTotal, "g"))];
    const total = todosTotales.length > 0
      ? todosTotales[todosTotales.length - 1]![0].replace(/\s+/g, " ").trim()
      : "No encontrado";
    const cifs = textoCompleto.match(new RegExp(regexCIF, "g")) || [];
    const cifEmisor = cifs[0] || "No encontrado";
    const cifReceptor = cifs[1] || "No encontrado";
    const telefono = textoCompleto.match(regexTelefono)?.[1]?.replace(/\s+/g, "") || "No encontrado";
    const cliente = regionText.replace(/\s+/g, " ").trim();

    // Capturamos TODAS las secciones CÓDIGO...TOTAL IMP (una por página no-copia).
    // Las páginas "Es copia" ya están filtradas arriba al construir textoCompleto.
    const seccionesLineas = textoCompleto.match(/C.DIGO[\s\S]+?(?=TOTAL\s+IMP)/gi)?.join("\n") ?? textoCompleto;

    // Código: alternativa entre
    //   a) 2+ mayúsculas con al menos un dígito en alguna posición posterior
    //      (MBA22, NT6202LLUC3, MBS`ZX630, VOM90S21,554023, ...), o
    //   b) 6+ mayúsculas todo letras (BRBRUSIL, NTENGRASUNIVER, ZZMECANIZADO).
    // El mínimo de 6 en (b) descarta palabras sueltas tipo SUMA (4), TOTAL (5),
    // FECHA, FORMA, GIRO sin necesitar lista negra.
    // Uso `^` con flag `m` y `[ \t]` en vez de `\s` para acotar la línea física.
    // Tres alternativas para el código:
    //  a) letras + dígitos (MBA22, NT6202LLU, MBS`ZX630, VOM90S21,554023)
    //  b) 6+ mayúsculas con tildes y opcional , o . al final (BRBRUSIL,
    //     NTENGRASUNIVER, ZZMECANIZADO, COMPROBACIÓN,)
    //  c) letras + espacio + dígitos (PAP 2020, para líneas extra sin código
    //     en columna donde la descripción empieza con un identificador así).
    //     No incluye \s para no cruzar saltos de línea.
    // La descripción es opcional: cubre el caso "GRILLONES 3,00" donde el código
    // viene seguido directamente del número de unidades sin descripción intermedia.
    const regexLinea = /^[ \t]*([A-Z]{2,}[A-Z0-9`,\/.\-]*?\d[A-Z0-9`,\/.\-]*|[A-ZÁÉÍÓÚÑÜÇ]{6,}[,.]?|[A-Z]{2,}[ \t]\d+[A-Z0-9]*)[ \t]+(?:(.+?)[ \t]+)?(-?\d+(?:\.\d{3})*,\d+)(?=[ \t]|$)(?:[ \t]+(-?\d+(?:\.\d{3})*,\d+)(?=[ \t]|$))?(?:[ \t]+(-?\d+(?:\.\d{3})*,\d+)(?=[ \t]|$))?(?:[ \t]+(-?\d+(?:\.\d{3})*,\d+)(?=[ \t]|$))?(?:[ \t]+(-?\d+(?:\.\d{3})*,\d+)(?=[ \t]|$))?(?![ \t]*€)/gm;

    // Segundo pase: líneas SIN código (solo descripción + 3-5 números) tipo
    // "JUEGO LIMAS RE. FACOM LIM250EM.J5 2,00 54,770 109,54". Descripción debe
    // empezar por palabra todo-letras (descarta "MBA22 ..." que ya entra por
    // la primera regex), exige 3 números mínimo al final de la línea (descarta
    // "SUMA Y SIGUE 215,18" con 1 sólo) y prohibe € (descarta "DE 23,81 €").
    const regexLineaSinCodigo = /^[ \t]*([A-Z]+(?:[ \t]+[A-Z0-9][A-Z0-9.,\-\/]*)+)[ \t]+(-?\d+(?:\.\d{3})*,\d+)[ \t]+(-?\d+(?:\.\d{3})*,\d+)[ \t]+(-?\d+(?:\.\d{3})*,\d+)(?:[ \t]+(-?\d+(?:\.\d{3})*,\d+))?(?:[ \t]+(-?\d+(?:\.\d{3})*,\d+))?(?![ \t]*€)/gm;

    const matchesConCodigo = [...seccionesLineas.matchAll(regexLinea)];
    const indicesUsados = new Set(matchesConCodigo.map(m => m.index));

    const lineasConCodigo = matchesConCodigo.map(m => {
      const nums = [m[3], m[4], m[5], m[6], m[7]].filter((v): v is string => v !== undefined);
      return {
        idx: m.index ?? 0,
        codigo: m[1] ?? "",
        descripcion: m[2] ?? "",
        unidades: nums[0] ?? "",
        precio: nums[1] ?? "",
        dto1: nums.length >= 4 ? (nums[2] ?? "-") : "-",
        dto2: nums.length >= 5 ? (nums[3] ?? "-") : "-",
        importe: nums.length >= 3 ? (nums[nums.length - 1] ?? "") : "",
      };
    });

    const lineasSinCodigo = [...seccionesLineas.matchAll(regexLineaSinCodigo)]
      .filter(m => !indicesUsados.has(m.index))
      .map(m => {
        const nums = [m[2], m[3], m[4], m[5], m[6]].filter((v): v is string => v !== undefined);
        return {
          idx: m.index ?? 0,
          codigo: "",
          descripcion: m[1] ?? "",
          unidades: nums[0] ?? "",
          precio: nums[1] ?? "",
          dto1: nums.length >= 4 ? (nums[2] ?? "-") : "-",
          dto2: nums.length >= 5 ? (nums[3] ?? "-") : "-",
          importe: nums.length >= 3 ? (nums[nums.length - 1] ?? "") : "",
        };
      });

    const lineas = [...lineasConCodigo, ...lineasSinCodigo]
      .sort((a, b) => a.idx - b.idx)
      .map(({ idx: _idx, ...rest }) => rest);

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
