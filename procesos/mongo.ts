import { MongoClient, type Db, type Collection } from "mongodb";
import type { DatosFactura } from "./regex";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const DB_NAME     = process.env.MONGODB_DB   ?? "pdf-tools";

let client: MongoClient | null = null;

async function getColeccion(): Promise<Collection> {
  if (!client) {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
  }
  const db: Db = client.db(DB_NAME);
  return db.collection("facturas");
}

/**
 * Inserta o actualiza una factura en MongoDB.
 * Clave única: { archivo } → un registro por PDF, el método se sobrescribe.
 */
export async function guardarFactura(metodo: string, datos: DatosFactura): Promise<void> {
  if (!datos) return;
  const col = await getColeccion();
  await col.updateOne(
    { archivo: datos.archivo },
    {
      $set: {
        archivo:     datos.archivo,
        nFactura:    datos.nFactura,
        fecha:       datos.fecha,
        cliente:     datos.cliente,
        telefono:    datos.telefono,
        cifEmisor:   datos.cifEmisor,
        cifReceptor: datos.cifReceptor,
        total:       datos.total,
        lineas:      datos.lineas ?? [],
        metodo,
        actualizadoEn: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function buscarFacturas(filtros: {
  nFactura?:    string;
  cliente?:     string;
  fecha?:       string;
  cifReceptor?: string;
  metodo?:      string;
  page:         number;
  limit:        number;
}): Promise<{ total: number; facturas: any[] }> {
  const col = await getColeccion();
  const q: Record<string, any> = {};
  if (filtros.nFactura)    q.nFactura    = { $regex: filtros.nFactura,    $options: "i" };
  if (filtros.cliente)     q.cliente     = { $regex: filtros.cliente,     $options: "i" };
  if (filtros.fecha)       q.fecha       = { $regex: filtros.fecha,       $options: "i" };
  if (filtros.cifReceptor) q.cifReceptor = { $regex: filtros.cifReceptor, $options: "i" };
  if (filtros.metodo)      q.metodo      = filtros.metodo;
  const skip = (filtros.page - 1) * filtros.limit;
  const [total, facturas] = await Promise.all([
    col.countDocuments(q),
    col.find(q, { projection: { _id: 0 } }).skip(skip).limit(filtros.limit).toArray(),
  ]);
  return { total, facturas };
}

export async function obtenerTodasFacturas(): Promise<any[]> {
  const col = await getColeccion();
  return col.find({}, { projection: { _id: 0 } }).toArray();
}

export async function cerrarConexion(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
