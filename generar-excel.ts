import { exportarExcel } from "./procesos/excel";
import { cerrarConexion } from "./procesos/mongo";

console.log("📊 Generando Excel desde MongoDB...");
try {
  const ruta = await exportarExcel();
  if (ruta) console.log(`✅ Excel guardado en: ${ruta}`);
} catch (e: any) {
  console.error("❌ Error al generar Excel:", e.message);
} finally {
  await cerrarConexion();
}
