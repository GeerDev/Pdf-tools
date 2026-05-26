import { buscarFacturas, cerrarConexion } from "./procesos/mongo";

const PORT      = parseInt(process.env.PORT      ?? "3000");
const AUTH_USER = process.env.AUTH_USER ?? "admin";
const AUTH_PASS = process.env.AUTH_PASS ?? "changeme";

function checkAuth(req: Request): boolean {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Basic ")) return false;
  const decoded = atob(header.slice(6));
  const colon = decoded.indexOf(":");
  if (colon === -1) return false;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  return user === AUTH_USER && pass === AUTH_PASS;
}

// ── HTML de la interfaz ────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Facturas — PDF Tools</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f0f2f5; color: #222; }
    header { background: #2E4057; color: #fff; padding: 14px 24px; display: flex; align-items: center; gap: 10px; }
    header h1 { font-size: 1.1rem; font-weight: 600; }

    .container { max-width: 1500px; margin: 0 auto; padding: 20px 24px; }

    .filters {
      background: #fff; border-radius: 8px; padding: 16px 20px;
      margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.1);
    }
    .filters-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px; align-items: end;
    }
    .fg label {
      display: block; font-size: .72rem; font-weight: 700; color: #666;
      text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px;
    }
    .fg input, .fg select {
      width: 100%; padding: 7px 10px; border: 1px solid #d5d5d5;
      border-radius: 6px; font-size: .88rem;
    }
    .fg input:focus, .fg select:focus { outline: none; border-color: #2E4057; }
    .btn-row { display: flex; gap: 8px; align-items: flex-end; }
    .btn { padding: 7px 18px; background: #2E4057; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: .88rem; font-weight: 500; }
    .btn:hover { background: #1d2e3e; }
    .btn-sec { background: #e4e4e4; color: #333; }
    .btn-sec:hover { background: #ccc; }

    .info-bar { display: flex; justify-content: space-between; font-size: .82rem; color: #666; margin-bottom: 8px; }

    .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); overflow: hidden; }
    table { width: 100%; border-collapse: collapse; font-size: .83rem; }
    thead th { background: #2E4057; color: #fff; padding: 9px 12px; text-align: left; white-space: nowrap; font-weight: 600; }
    tbody tr { border-bottom: 1px solid #f0f0f0; cursor: pointer; }
    tbody tr:hover { background: #f4f7ff; }
    tbody tr.expanded { background: #edf1ff; }
    td { padding: 8px 12px; }
    td.archivo { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #666; font-size: .77rem; }
    td.total { font-weight: 600; text-align: right; }
    .badge { display: inline-block; padding: 2px 9px; border-radius: 12px; font-size: .73rem; font-weight: 700; }
    .badge-pdf { background: #e8f5e9; color: #2e7d32; }
    .badge-ia  { background: #e3f2fd; color: #1565c0; }

    .lineas-row td { padding: 0; }
    .lineas-inner { padding: 12px 28px 14px; background: #f7f9ff; border-top: 2px solid #2E4057; }
    .lineas-inner p.empty { color: #999; font-style: italic; font-size: .85rem; }
    .lineas-inner table { font-size: .81rem; }
    .lineas-inner thead th { background: #4a6080; font-weight: 600; }
    .lineas-inner tbody tr { background: #fff; }
    .lineas-inner tbody tr:hover { background: #eef2ff; }

    .pagination { display: flex; gap: 6px; justify-content: center; margin-top: 14px; align-items: center; }
    .pagination button { padding: 5px 12px; border: 1px solid #d5d5d5; border-radius: 6px; background: #fff; cursor: pointer; font-size: .82rem; }
    .pagination button:hover:not(:disabled) { background: #2E4057; color: #fff; border-color: #2E4057; }
    .pagination button:disabled { opacity: .35; cursor: default; }
    .pagination .cur { background: #2E4057; color: #fff; border-color: #2E4057; }

    #loading { text-align: center; padding: 40px; color: #aaa; }
    #empty   { text-align: center; padding: 40px; color: #aaa; display: none; }
  </style>
</head>
<body>
<header>
  <span style="font-size:1.4rem">📄</span>
  <h1>Facturas — PDF Tools</h1>
</header>

<div class="container">
  <div class="filters">
    <div class="filters-grid">
      <div class="fg"><label>Nº Factura</label><input id="f-nf" type="text" placeholder="A 23242"></div>
      <div class="fg"><label>Cliente</label><input id="f-cl" type="text" placeholder="Nombre o razón social"></div>
      <div class="fg"><label>Fecha</label><input id="f-fe" type="text" placeholder="30/12/20"></div>
      <div class="fg"><label>CIF Receptor</label><input id="f-cr" type="text" placeholder="A46412748"></div>
      <div class="fg">
        <label>Método</label>
        <select id="f-mt">
          <option value="">Todos</option>
          <option value="PDF_EXTRACTION">PDF_EXTRACTION</option>
          <option value="IA_EXTRACTION">IA_EXTRACTION</option>
        </select>
      </div>
      <div class="fg btn-row">
        <button class="btn" onclick="buscar(1)">Buscar</button>
        <button class="btn btn-sec" onclick="resetar()">Limpiar</button>
      </div>
    </div>
  </div>

  <div class="info-bar">
    <span id="lbl-total"></span>
    <span id="lbl-page"></span>
  </div>

  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Nº Factura</th><th>Fecha</th><th>Cliente</th>
          <th>Teléfono</th><th>CIF Emisor</th><th>CIF Receptor</th>
          <th>Total</th><th>Método</th><th>Archivo</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
    <div id="loading">Cargando...</div>
    <div id="empty">No se encontraron resultados.</div>
  </div>

  <div class="pagination" id="pag"></div>
</div>

<script>
  var currentPage = 1;
  var expandedTr   = null;

  function buscar(page) {
    currentPage = page || 1;
    var params = new URLSearchParams();
    params.set('nFactura',    document.getElementById('f-nf').value.trim());
    params.set('cliente',     document.getElementById('f-cl').value.trim());
    params.set('fecha',       document.getElementById('f-fe').value.trim());
    params.set('cifReceptor', document.getElementById('f-cr').value.trim());
    params.set('metodo',      document.getElementById('f-mt').value);
    params.set('page',        String(currentPage));
    params.set('limit',       '50');

    document.getElementById('loading').style.display = 'block';
    document.getElementById('empty').style.display   = 'none';
    document.getElementById('tbody').innerHTML        = '';
    document.getElementById('lbl-total').textContent  = '';
    document.getElementById('lbl-page').textContent   = '';
    document.getElementById('pag').innerHTML          = '';
    expandedTr = null;

    fetch('/api/facturas?' + params.toString())
      .then(function(r) { return r.json(); })
      .then(function(data) {
        document.getElementById('loading').style.display = 'none';
        if (!data.facturas || data.facturas.length === 0) {
          document.getElementById('empty').style.display = 'block';
          return;
        }
        var totalPages = Math.ceil(data.total / 50);
        document.getElementById('lbl-total').textContent = data.total + ' factura(s) en total';
        document.getElementById('lbl-page').textContent  = 'Mostrando ' + data.facturas.length + ' · Página ' + currentPage + ' de ' + totalPages;
        renderTabla(data.facturas);
        renderPag(currentPage, totalPages);
      })
      .catch(function(e) {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('tbody').innerHTML = '<tr><td colspan="9" style="padding:20px;color:red">Error: ' + e.message + '</td></tr>';
      });
  }

  function esc(v) {
    return String(v || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderTabla(facturas) {
    var tbody = document.getElementById('tbody');
    for (var i = 0; i < facturas.length; i++) {
      (function(f) {
        var tr = document.createElement('tr');
        var badge = f.metodo === 'IA_EXTRACTION'
          ? '<span class="badge badge-ia">IA_EXTRACTION</span>'
          : '<span class="badge badge-pdf">PDF_EXTRACTION</span>';
        tr.innerHTML =
          '<td>' + esc(f.nFactura)    + '</td>' +
          '<td>' + esc(f.fecha)       + '</td>' +
          '<td>' + esc(f.cliente)     + '</td>' +
          '<td>' + esc(f.telefono)    + '</td>' +
          '<td>' + esc(f.cifEmisor)   + '</td>' +
          '<td>' + esc(f.cifReceptor) + '</td>' +
          '<td class="total">' + esc(f.total) + '</td>' +
          '<td>' + badge + '</td>' +
          '<td class="archivo" title="' + esc(f.archivo) + '">' + esc(f.archivo) + '</td>';
        tr.addEventListener('click', function() { toggleLineas(tr, f); });
        tbody.appendChild(tr);
      })(facturas[i]);
    }
  }

  function toggleLineas(tr, f) {
    if (expandedTr && expandedTr !== tr) {
      expandedTr.classList.remove('expanded');
      var prev = expandedTr.nextSibling;
      if (prev && prev.classList && prev.classList.contains('lineas-row')) prev.remove();
    }
    if (expandedTr === tr) {
      tr.classList.remove('expanded');
      var nxt = tr.nextSibling;
      if (nxt && nxt.classList && nxt.classList.contains('lineas-row')) nxt.remove();
      expandedTr = null;
      return;
    }
    tr.classList.add('expanded');
    expandedTr = tr;

    var lr = document.createElement('tr');
    lr.className = 'lineas-row';
    var td = document.createElement('td');
    td.colSpan = 9;

    if (!f.lineas || f.lineas.length === 0) {
      td.innerHTML = '<div class="lineas-inner"><p class="empty">Sin líneas de detalle.</p></div>';
    } else {
      var rows = '';
      for (var i = 0; i < f.lineas.length; i++) {
        var l = f.lineas[i];
        rows +=
          '<tr>' +
          '<td>' + esc(l.codigo)      + '</td>' +
          '<td>' + esc(l.descripcion) + '</td>' +
          '<td style="text-align:right">' + esc(l.unidades) + '</td>' +
          '<td style="text-align:right">' + esc(l.precio)   + '€</td>' +
          '<td style="text-align:right">' + esc(l.dto1)     + '%</td>' +
          '<td style="text-align:right">' + esc(l.dto2)     + '%</td>' +
          '<td style="text-align:right;font-weight:600">' + esc(l.importe) + '€</td>' +
          '</tr>';
      }
      td.innerHTML =
        '<div class="lineas-inner">' +
          '<table>' +
            '<thead><tr>' +
              '<th>Código</th><th>Descripción</th><th>Uds.</th>' +
              '<th>Precio</th><th>DTO1%</th><th>DTO2%</th><th>Importe</th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>';
    }
    lr.appendChild(td);
    tr.after(lr);
  }

  function renderPag(page, totalPages) {
    var div = document.getElementById('pag');
    div.innerHTML = '';

    var prev = document.createElement('button');
    prev.textContent = '← Anterior';
    prev.disabled = page === 1;
    prev.onclick = function() { buscar(page - 1); };
    div.appendChild(prev);

    var start = Math.max(1, page - 2);
    var end   = Math.min(totalPages, page + 2);
    for (var i = start; i <= end; i++) {
      (function(p) {
        var btn = document.createElement('button');
        btn.textContent = String(p);
        if (p === page) btn.className = 'cur';
        btn.onclick = function() { buscar(p); };
        div.appendChild(btn);
      })(i);
    }

    var next = document.createElement('button');
    next.textContent = 'Siguiente →';
    next.disabled = page === totalPages;
    next.onclick = function() { buscar(page + 1); };
    div.appendChild(next);
  }

  function resetar() {
    document.getElementById('f-nf').value = '';
    document.getElementById('f-cl').value = '';
    document.getElementById('f-fe').value = '';
    document.getElementById('f-cr').value = '';
    document.getElementById('f-mt').value = '';
    buscar(1);
  }

  document.querySelectorAll('.filters input').forEach(function(el) {
    el.addEventListener('keydown', function(e) { if (e.key === 'Enter') buscar(1); });
  });

  buscar(1);
</script>
</body>
</html>`;

// ── Servidor ───────────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    if (!checkAuth(req)) {
      return new Response("No autorizado", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="PDF Tools"' },
      });
    }

    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/facturas") {
      const p = url.searchParams;
      try {
        const result = await buscarFacturas({
          nFactura:    p.get("nFactura")    || undefined,
          cliente:     p.get("cliente")     || undefined,
          fecha:       p.get("fecha")       || undefined,
          cifReceptor: p.get("cifReceptor") || undefined,
          metodo:      p.get("metodo")      || undefined,
          page:        Math.max(1,   parseInt(p.get("page")  ?? "1")),
          limit:       Math.min(100, parseInt(p.get("limit") ?? "50")),
        });
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`🌐 Servidor en http://localhost:${PORT}`);
console.log("   Pulsa Ctrl+C para detener.\n");

process.on("SIGINT", async () => {
  await cerrarConexion();
  server.stop();
  process.exit(0);
});
