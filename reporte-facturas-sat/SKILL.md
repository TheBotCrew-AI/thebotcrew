---
name: reporte-facturas-sat
description: Convierte los XML de facturas del SAT (CFDI 4.0) en un Excel con resumen de ingresos, IVA, retenciones, ventas por mes y por cliente, y alertas (canceladas, folios faltantes, PPD sin complemento, cliente que concentra tus ingresos). Úsalo cuando el usuario suba XML de facturas, un .zip de la descarga masiva del SAT, o pida un reporte, resumen o análisis de sus facturas.
---

# Reporte de facturas SAT

Convierte una carpeta o un .zip con XML de CFDI 4.0 en un Excel listo para el dueño del negocio.

## Pasos

1. Pide al usuario sus XML si no los ha subido. Acepta archivos .xml sueltos, una carpeta o un .zip (por ejemplo, la descarga masiva del portal del SAT). Los PDF no sirven: solo el XML trae los datos.
2. Si subió .xml sueltos, ponlos todos en una carpeta.
3. Guarda el código de la sección "Código" (al final) como `reporte_cfdi.py`, sin cambiarlo, y ejecútalo:
   ```
   python reporte_cfdi.py <carpeta_o_zip> Reporte_Facturas_SAT.xlsx
   ```
   Requiere `openpyxl`. Si falta, instálalo con `pip install openpyxl`.
4. Entrega el archivo `Reporte_Facturas_SAT.xlsx` al usuario.
5. En el chat, resume en 4 a 6 líneas lo más importante: ingresos totales, mes más fuerte y más débil, cliente principal y su porcentaje, y cada alerta que imprimió el script. Usa lenguaje de dueño de negocio, no de contador.

## Qué contiene el Excel

- **Resumen:** ingresos (subtotal de facturas vigentes), IVA cobrado, ISR retenido, total cobrado, número de facturas, ticket promedio, gastos facturados a su nombre e IVA acreditable. Incluye tablas por mes y por cliente, y una gráfica de ingresos por mes. Todo usa fórmulas que apuntan a la hoja Detalle.
- **Alertas:** facturas canceladas, folios faltantes en la serie, facturas PPD que necesitan complemento de pago, facturas a extranjero sin IVA, y concentración de ingresos en un solo cliente (más de 50%).
- **Detalle:** una fila por factura, con filtros.

## Reglas

- El RFC del usuario se detecta como el emisor más frecuente. Las facturas donde el usuario es emisor son "Emitida" (ingresos) y las demás son "Recibida" (gastos).
- El XML no indica si una factura fue cancelada. El script solo la marca como cancelada si la carpeta o el archivo dice "cancelada". Recuérdale al usuario que confirme el estatus en el portal del SAT.
- No des asesoría fiscal. Si una alerta implica un trámite (complementos, cancelaciones, exportación), sugiere revisarlo con su contador.

## Código

```python
#!/usr/bin/env python3
"""Lee XML de CFDI 4.0 (carpeta o .zip) y genera un Excel con resumen, alertas y detalle.
Uso: python reporte_cfdi.py <carpeta_o_zip> [salida.xlsx]"""
import sys, os, glob, json, zipfile, tempfile, collections
import xml.etree.ElementTree as ET
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.chart import BarChart, Reference
from openpyxl.utils import get_column_letter
NS={'cfdi':'http://www.sat.gob.mx/cfd/4','tfd':'http://www.sat.gob.mx/TimbreFiscalDigital'}
src=sys.argv[1]; out=sys.argv[2] if len(sys.argv)>2 else 'Reporte_Facturas_SAT.xlsx'
if src.lower().endswith('.zip'):
    tmp=tempfile.mkdtemp(); zipfile.ZipFile(src).extractall(tmp); src=tmp
sys.argv[1]=src
rows=[]
for p in glob.glob(os.path.join(sys.argv[1],'**','*.xml'),recursive=True):
    try: r=ET.parse(p).getroot()
    except Exception as e: print('skip',p,e); continue
    if not r.tag.endswith('Comprobante'): continue
    e=r.find('cfdi:Emisor',NS); rc=r.find('cfdi:Receptor',NS)
    imp=r.find('cfdi:Impuestos',NS)
    tras=float(imp.get('TotalImpuestosTrasladados',0)) if imp is not None else 0
    ret_isr=ret_iva=0
    if imp is not None:
        for x in imp.findall('cfdi:Retenciones/cfdi:Retencion',NS):
            if x.get('Impuesto')=='001': ret_isr+=float(x.get('Importe'))
            if x.get('Impuesto')=='002': ret_iva+=float(x.get('Importe'))
    concs=[c.get('Descripcion') for c in r.findall('cfdi:Conceptos/cfdi:Concepto',NS)]
    t=r.find('.//tfd:TimbreFiscalDigital',NS)
    rows.append(dict(archivo=os.path.relpath(p,sys.argv[1]),fecha=r.get('Fecha')[:10],serie=r.get('Serie',''),folio=r.get('Folio',''),
      tipo=r.get('TipoDeComprobante'),emisor_rfc=e.get('Rfc'),emisor=e.get('Nombre'),regimen_emisor=e.get('RegimenFiscal'),
      receptor_rfc=rc.get('Rfc'),receptor=rc.get('Nombre'),uso=rc.get('UsoCFDI'),
      subtotal=float(r.get('SubTotal')),iva=tras,ret_isr=ret_isr,ret_iva=ret_iva,total=float(r.get('Total')),
      moneda=r.get('Moneda'),metodo=r.get('MetodoPago'),forma=r.get('FormaPago'),concepto=' | '.join(concs),
      uuid=t.get('UUID') if t is not None else '',cancelada_carpeta='cancelad' in p.lower()))

if not rows: sys.exit('No encontré XML de CFDI 4.0 en '+src)

me=collections.Counter(r['emisor_rfc'] for r in rows).most_common(1)[0][0]
for r in rows:
    r['flujo']='Emitida' if r['emisor_rfc']==me else 'Recibida'
    r['estatus']='Cancelada' if r['cancelada_carpeta'] else 'Vigente'
    r['contraparte']=r['receptor'] if r['flujo']=='Emitida' else r['emisor']
    r['mes']=r['fecha'][:7]
rows.sort(key=lambda r:(r['fecha'],r['folio']))
F='Arial'; H=Font(name=F,bold=True,color='FFFFFF'); HF=PatternFill('solid',fgColor='3B2A20')
B=Font(name=F); BB=Font(name=F,bold=True); T=Font(name=F,bold=True,size=16,color='3B2A20')
MXN='$#,##0.00;($#,##0.00);-'; GOLD=PatternFill('solid',fgColor='F3E6CF')
thin=Border(bottom=Side(style='thin',color='DDDDDD'))
wb=Workbook()
# Detalle
d=wb.active; d.title='Detalle'
cols=[('Fecha','fecha'),('Mes','mes'),('Tipo','flujo'),('Estatus','estatus'),('Serie','serie'),('Folio','folio'),('Cliente / Proveedor','contraparte'),('RFC contraparte',None),('Concepto','concepto'),('Subtotal','subtotal'),('IVA','iva'),('Ret. ISR','ret_isr'),('Ret. IVA','ret_iva'),('Total','total'),('Método','metodo'),('Forma pago','forma'),('Uso CFDI','uso'),('UUID','uuid')]
for i,(h,_) in enumerate(cols,1):
    c=d.cell(1,i,h); c.font=H; c.fill=HF
for n,r in enumerate(rows,2):
    for i,(h,k) in enumerate(cols,1):
        v=r[k] if k else (r['receptor_rfc'] if r['flujo']=='Emitida' else r['emisor_rfc'])
        c=d.cell(n,i,v); c.font=B
        if h in('Subtotal','IVA','Ret. ISR','Ret. IVA','Total'): c.number_format=MXN
last=len(rows)+1
widths=[11,9,10,10,6,7,34,16,40,12,11,10,10,12,8,10,9,38]
for i,w in enumerate(widths,1): d.column_dimensions[get_column_letter(i)].width=w
d.freeze_panes='A2'; d.auto_filter.ref=f'A1:R{last}'
rng=lambda col:f"Detalle!${col}$2:${col}${last}"
E=f'{rng("C")},"Emitida",{rng("D")},"Vigente"'
# Resumen
s=wb.create_sheet('Resumen',0)
s['A1']='Tus facturas en 10 segundos'; s['A1'].font=T
s['A2']=f'RFC: {me}  ·  {len(rows)} XML leídos  ·  {rows[0]["fecha"]} a {rows[-1]["fecha"]}'; s['A2'].font=Font(name=F,italic=True,color='777777')
kpis=[('Ingresos facturados (subtotal, vigentes)',f'=SUMIFS({rng("J")},{E})'),
('IVA cobrado',f'=SUMIFS({rng("K")},{E})'),
('ISR que te retuvieron tus clientes',f'=SUMIFS({rng("L")},{E})'),
('Total cobrado (neto)',f'=SUMIFS({rng("N")},{E})'),
('Facturas emitidas vigentes',f'=COUNTIFS({E})'),
('Facturas canceladas',f'=COUNTIFS({rng("D")},"Cancelada")'),
('Ticket promedio por factura','=IFERROR(B4/B8,0)'),
('Gastos facturados a tu nombre (subtotal)',f'=SUMIFS({rng("J")},{rng("C")},"Recibida",{rng("D")},"Vigente")'),
('IVA acreditable de gastos',f'=SUMIFS({rng("K")},{rng("C")},"Recibida",{rng("D")},"Vigente")')]
for i,(l,f) in enumerate(kpis,4):
    s.cell(i,1,l).font=B; c=s.cell(i,2,f); c.font=BB; c.fill=GOLD
    c.number_format='0' if 'Facturas' in l else MXN
    s.cell(i,1).border=thin
s.column_dimensions['A'].width=44; s.column_dimensions['B'].width=18
# Por mes
months=sorted({r['mes'] for r in rows})
s['D3']='Por mes'; s['D3'].font=BB
for j,h in enumerate(['Mes','Ingresos','IVA','Ret. ISR','# Facturas'],4):
    c=s.cell(4,j,h); c.font=H; c.fill=HF
for i,m in enumerate(months,5):
    s.cell(i,4,m).font=B
    for j,col in [(5,'J'),(6,'K'),(7,'L')]:
        c=s.cell(i,j,f'=SUMIFS({rng(col)},{E},{rng("B")},D{i})'); c.number_format=MXN; c.font=B
    s.cell(i,8,f'=COUNTIFS({E},{rng("B")},D{i})').font=B
mt=4+len(months)
s.cell(mt+1,4,'Total').font=BB
for j in range(5,9):
    L=get_column_letter(j); c=s.cell(mt+1,j,f'=SUM({L}5:{L}{mt})'); c.font=BB
    c.number_format=MXN if j<8 else '0'
for L,w in zip('DEFGH',[10,14,12,12,11]): s.column_dimensions[L].width=w
# Por cliente
clients=[c for c,_ in collections.Counter(r['contraparte'] for r in rows if r['flujo']=='Emitida' and r['estatus']=='Vigente').most_common()]
r0=mt+4
s.cell(r0-1,4,'Por cliente').font=BB
for j,h in enumerate(['Cliente','Ingresos','% del total','# Facturas'],4):
    c=s.cell(r0,j,h); c.font=H; c.fill=HF
for i,cl in enumerate(clients,r0+1):
    s.cell(i,4,cl).font=B
    c=s.cell(i,5,f'=SUMIFS({rng("J")},{E},{rng("G")},D{i})'); c.number_format=MXN
    c=s.cell(i,6,f'=IFERROR(E{i}/$B$4,0)'); c.number_format='0.0%'
    s.cell(i,7,f'=COUNTIFS({E},{rng("G")},D{i})')
s.column_dimensions['D'].width=36
# Alertas
al=[]
canc=[r for r in rows if r['estatus']=='Cancelada']
if canc: al.append(('Revisar',f'{len(canc)} facturas marcadas como canceladas (folios {", ".join(r["folio"] for r in canc)}). Confirma en el portal del SAT que la cancelación quedó aceptada.'))
ext=[r for r in rows if r['flujo']=='Emitida' and r['receptor_rfc']=='XEXX010101000' and r['estatus']=='Vigente']
if ext: al.append(('Info',f'{len(ext)} facturas a cliente extranjero (RFC genérico XEXX010101000), todas sin IVA. Confírmalo con tu contador si es exportación de servicios.'))
fol=sorted(int(r['folio']) for r in rows if r['flujo']=='Emitida' and r['folio'].isdigit())
gap=[f for f in range(fol[0],fol[-1]) if f not in fol]
if gap: al.append(('Revisar',f'Faltan los folios {", ".join(map(str,gap))} en esta carpeta. ¿Se emitieron? Si sí, faltan sus XML; si no, todo bien.'))
ppd=[r for r in rows if r['metodo']=='PPD']
al.append(('OK' if not ppd else 'Revisar', 'Ninguna factura PPD: no necesitas complementos de pago.' if not ppd else f'{len(ppd)} facturas PPD: cada una necesita su complemento de pago.'))
top=collections.Counter()
for r in rows:
    if r['flujo']=='Emitida' and r['estatus']=='Vigente': top[r['contraparte']]+=r['subtotal']
tot=sum(top.values()); c1,v1=top.most_common(1)[0]
if v1/tot>0.5: al.append(('Riesgo',f'{c1} es el {v1/tot:.0%} de tus ingresos. Si se va ese cliente, pierdes más de la mitad.'))
a=wb.create_sheet('Alertas',1)
a['A1']='Lo que tu contador te diría'; a['A1'].font=T
for j,h in enumerate(['Nivel','Hallazgo'],1):
    c=a.cell(3,j,h); c.font=H; c.fill=HF
for i,(n,t) in enumerate(al,4):
    a.cell(i,1,n).font=BB; c=a.cell(i,2,t); c.font=B; c.alignment=Alignment(wrap_text=True,vertical='top')
a.column_dimensions['A'].width=10; a.column_dimensions['B'].width=95
a.cell(len(al)+6,1,'Nota: el XML no dice si una factura está cancelada; aquí se tomó del nombre de la carpeta. Esto es una herramienta de revisión, no asesoría fiscal.').font=Font(name=F,italic=True,size=9,color='777777')
# chart
ch=BarChart(); ch.title='Ingresos por mes'; ch.y_axis.title='MXN'
ch.add_data(Reference(s,min_col=5,min_row=4,max_row=mt),titles_from_data=True)
ch.set_categories(Reference(s,min_col=4,min_row=5,max_row=mt))
ch.roundedCorners=False; ch.legend=None; ch.title.overlay=False
ch.x_axis.delete=False; ch.y_axis.delete=False; ch.height=7; ch.width=14
s.add_chart(ch,'A15')
wb.save(out)
print('Listo:',out,'|',len(rows),'facturas')
for n,t in al: print('-',n+':',t)
```
