# Lectura del HUD y del panel de uso

[English version](reading-the-hud.md)

Dos pantallas responden a dos preguntas clave:

| Pantalla | Abrir con | Pregunta que responde |
|---|---|---|
| Panel de uso | `ctrl+alt+u` o `/balancer usage` | ¿Qué gasté, en qué proveedor y cuándo se llenó una quota? |
| HUD | `/hud` | ¿Cuán llena está cada subscription en este momento y aguantará hasta su reset? |

Ambas leen el mismo historial local (`data/history/`). Nada se envía al exterior.

## Primero: qué significa un número de tokens

Cada línea que indica `40.7M`, `950.6k` o `143.7M` es un conteo de **tokens**: `k` significa miles,
`M` significa millones. Dicho número representa la suma de cuatro tipos de tokens:

| Tipo | Qué es | Peso en el costo |
|---|---|---|
| `input` | Texto nuevo enviado al modelo sin cache | Precio completo |
| `cache write` | Texto enviado una vez y almacenado en el cache del provider | Igual a input, o levemente superior |
| `cache read` | Texto que el modelo ya tenía en cache, enviado nuevamente | Alrededor de 1/20 de input |
| `output` | Lo que el modelo escribió de vuelta | El más costoso |

La idea central: **cada petición reenvía la conversación completa**. Una sesión con 150k tokens de
context envía esos 150k en cada turno, incluso al escribir una sola línea. El cache hace que sea
más económico, pero sigue computándose.

### Ejemplo práctico: `tokens 5h 40.7M`

La tarjeta de `/hud` para Claude Pro mostró `tokens 5h 40.7M` mientras la ventana de 5 horas estaba al 44%.
Desglosado desde el historial:

| Tipo | Tokens | Proporción |
|---|---|---|
| cache read | 39.6M | 97% |
| cache write | 0.9M | 2% |
| output | 0.2M | <1% |
| input | ~600 | 0% |

Por lo tanto, 40.7M **no** significa que los modelos hayan generado 40 millones de tokens. Escribieron
alrededor de 215k. El resto corresponde a la misma conversación releída en cada turno. Por esta razón
las sesiones extensas consumen una ventana rápidamente: la relectura crece con cada mensaje.
`/compact` o iniciar una sesión nueva restablece este volumen.

### Los tokens no son el porcentaje

El provider determina cómo impacta cada tipo de token contra una ventana y no publica dicha
fórmula. El **porcentaje** (`44%`) constituye la lectura propia del provider y representa la fuente
de verdad respecto a "cuánto queda disponible". El conteo de tokens explica **por qué** varió.

## Colores

Ambas pantallas aplican los mismos tres colores, y el HUD muestra la leyenda en pantalla:

| Color | Significado | Acción recomendada |
|---|---|---|
| Verde | Por debajo del 70% y rinde hasta el refill | Ninguna |
| Amarillo | Entre 70% y 89% | Monitorear; priorizar sesiones cortas |
| Rojo | 90% o más, lleno, o el ritmo indica que se agotará antes del refill | Reducir el ritmo, `/compact`, o derivar trabajo a otra subscription |

Una ventana se muestra en rojo en cuanto su ritmo proyecta que se agotará antes del refill, incluso al 55%.
La pestaña `1 now` y el HUD coinciden en este criterio. El medidor de context de la sesión en `1 now`
sigue la línea de estado: verde por debajo de 120k tokens, amarillo a partir de 120k, rojo a partir de 200k.
El texto atenuado (dim) es secundario: horas de reset, antigüedad de lecturas y avisos informativos.
Los colores provienen del tema activo en Pi.

## El panel de uso (`ctrl+alt+u`)

Teclas: `1`-`5` seleccionan una pestaña, `tab` cicla entre ellas, `pgup`/`pgdn`/`home`/`end` desplazan cuando la vista excede la altura de la terminal, `q` o `esc` cierran. Se actualiza automáticamente cada 5 segundos.

### `1 now`

Cada bloque representa una tarjeta. Se organizan lado a lado cuando el ancho de terminal lo permite
o en filas individuales cuando es estrecho.

```
╭─ This session · 01a155f0 ────────────────╮ ╭─ Last 24h · peak 15.3M/h ────────────╮
│ model claude-opus-5-5                    │ │ ············█··········▃                │
│ context  ▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱  15%           │ │ -24h                 now                │
│ 152.3k of 1.0M tokens                    │ │                                         │
│ requests 14   API $0.58                  │ │                                         │
│ input 28   output 9.8k                   │ │                                         │
│ cache read 900.4k   write 40.4k          │ │                                         │
│ total 950.6k                             │ │                                         │
╰──────────────────────────────────────────╯ ╰─────────────────────────────────────────╯

Subscriptions now
╭─ agy claude week ────────╮ ╭─ claude 5h ──────────────╮
│ ▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱  62%  │ │ ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  23%  │
│ resets in 1d 16h        │ │ resets in 4h 23m        │
│ read 7m ago             │ │ read 7m ago             │
╰─────────────────────────╯ ╰─────────────────────────╯
```

- `context`: cuánto reenvía esta sesión en cada petición frente al límite del modelo. A partir de
  120k tokens la línea de estado advierte `ctx … ⚠ /compact`.
- Las líneas de tokens desglosan los tokens de la sesión según su tipo. `API $0.58` refleja el costo
  equivalente en API paga a precio de lista (`prices.json`). No se abona bajo una subscription; sirve
  de referencia comparativa entre planes.
- `Subscriptions now`: una tarjeta por ventana de quota, titulada con el color de su nivel de llenado,
  con su medidor, tiempo de reset y antigüedad de la muestra.
- `Last 24h`: una barra por hora; la barra más alta marca el pico indicado en el título.
- `30 days by provider`: una tarjeta por provider con su volumen total, proporción porcentual y barra,
  peticiones y costo equivalente en API, más el mismo desglose de tokens.

### `2 quotas`

- Una tarjeta por ventana, lado a lado, titulada con su pico máximo y cantidad de saturaciones (fills).
  Cada una contiene un gráfico de columnas 0–100% a lo largo de los días registrados (los días previos
  a la primera lectura registrada se omiten con `no data before MM-DD`). Cada columna refleja el porcentaje
  pico en octavos de fila, `·` cuando no hubo lecturas ese día, un triángulo rojo `▲` sobre el eje 0%
  los días en que la ventana alcanzó el 100%, y fechas (`MM-DD`) bajo el eje. Las ventanas sin lecturas
  en dicho período se listan debajo de las tarjetas.
- `Report`: tabla con una fila por ventana saturada: repeticiones (`fills`), frecuencia promedio
  (`every 17h 14m`), tiempo demandado en llenarse (`fills in`) y duración del bloqueo. El guion `-`
  indica dato aún no determinado.
- `Fills`: tabla en orden cronológico inverso con cada momento en que una ventana alcanzó el 100%, la
  sesión que consumió más tokens antes del evento (`top session`, `tokens`) y la sesión cuya petición fue
  rechazada (`hit in`).

```
  window           fills  every   fills in  blocked
  claude 5h        5      11h 8m  4h 2m     4h 47m
```

### `3 days`

Una tarjeta por provider con el acumulado de 30 días en tokens, costo equivalente en API y, si `prices.json`
incluye el precio de su plan, a cuántos planes mensuales equivale (`vs plan $20 → 2.5x`). Debajo, una
tabla detallada por día (desde el primer registro hasta el día actual):

```
  day   tokens per day         total  claude-bridge  antigravity    API $
  10-20 █▓▓▓▓▓░░░░░░░░░░░░░░   43.6M          10.2M        33.5M    $9.09
  10-17 ░░░░░░░░░░░░░░░░░░░░       0              -            -        -
```

La barra está escalada respecto al día con mayor actividad (encabezado `0 … peak`) y desglosada por
provider (`█` primer provider, `▓` segundo, `▒` tercero+, `░` remanente); cada provider dispone de su
columna y el guion `-` indica ausencia de actividad ese día. `month pace` proyecta el gasto mensual
al ritmo actual para contrastarlo con el abono del plan.

### `4 sessions`

En orden cronológico inverso: proyecto, identificador de sesión, modelo (`+1` indica uso adicional de otro
modelo), peticiones, tokens, context máximo alcanzado (`peak ctx`) y costo equivalente en API. Un
`peak ctx` elevado con numerosas peticiones suele ser el principal factor de saturación de ventanas.

### `5 hud`

La versión compacta del HUD, detallada a continuación. Concluye con **Top consumers · last 7 days**:
los tres roles con mayor consumo en líneas individuales.

## El HUD (`/hud`)

Teclas: `1` subscriptions, `2` apis, `3` sessions, `4` suggestions, `tab` cicla,
`pgup`/`pgdn`/`home`/`end` desplazan (al truncarse líneas, la última fila indica
`↓ N more lines · pgdn`), `q` o `esc` cierran. El pie muestra exclusivamente las teclas operativas en la
vista activa:

- sessions: `↑↓ select · enter open · x compact · f fresh · 1-4/tab view · pgup/pgdn scroll · q close`
- suggestions: `↑↓ select · enter act · c profile · x compact · f fresh · 1-4/tab view · pgup/pgdn scroll · q close`

Acciones de cada tecla:

- `enter` en sessions conmuta Pi a la sesión seleccionada. En suggestions ejecuta la acción pertinente:
  abre su sesión, genera un profile adaptado ante "Try <model> for <role>" (equivalente a `c`,
  respaldando previamente `profiles.json`), y ante advertencias de quota explica el procedimiento sugerido.
- `x` ejecuta compactación sobre la sesión seleccionada: Pi conmuta a ella y corre `/compact`.
- `f` continúa la sesión seleccionada en una nueva: bifurca la original en su último mensaje y compacta
  únicamente la bifurcación, preservando la sesión original intacta.
- `x` y `f` solicitan confirmación. La fila seleccionada muestra
  `‼ x again: compact it, one large request summarizes "<name>" · any other key cancels` o
  `‼ f again: new session from a summary of "<name>", the original stays · any other key cancels`.
  Pulsar la misma tecla confirma la acción; cualquier otra tecla la cancela. Ambas aplican en sessions y
  suggestions, avisando cuando el elemento no tiene sesión asociada.

#### Por qué compactar ahorra tokens

Cada turno reenvía la conversación íntegra, por lo que una sesión prolongada paga el historial completo
en cada turno. La compactación reemplaza el historial previo por un resumen sintetizado, y cada turno
posterior reenvía únicamente dicha versión breve. Demanda una petición amplia inicial (el modelo procesa
todo el historial para sintetizarlo), amortizándose tras unos pocos turnos. Pi preserva los últimos ~20k
tokens (`keepRecentTokens`) sin resumir para mantener el contexto inmediato literal. Eliminar archivos
o historiales no reduce tokens: el factor determinante es el context reenviado en cada turno.

### Subscriptions: bridges y plugins

Una subscription (Claude Pro vía `claude-bridge`, Google AI Pro vía `agy`) posee **ventanas** (windows):
una cuota de uso que se renueva periódicamente. La ventana `5h` reinicia cinco horas tras su inicio;
la ventana `week` lo hace semanalmente.

```
Claude Pro (claude-bridge)
  tokens  5h 40.7M · today 75.3M · 7d 143.0M
  claude 5h            ▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱   44%  resets 20:30 (in 2h 34m)
                       +21.1%/h → full at 20:30, after the reset
  claude week          ▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱   66%  resets 10-20 11:00 (in 17h 4m)
                       +2.3%/h → full at 10-20 08:21, before the reset ⚠
```

Lectura de arriba hacia abajo:

1. `tokens`: tokens procesados por esta subscription en las últimas 5 horas, hoy y los últimos 7 días.
2. Un medidor por ventana: nivel de llenado y momento de renovación.
3. Línea de ritmo (pace): velocidad de llenado durante la última hora (`+21.1%/h`) y proyección de cuándo
   alcanzará el 100% a esa tasa.
   - `after the reset`: renovará antes de agotarse. Estado normal.
   - `before the reset ⚠`: se agotará antes de renovar. Conviene desacelerar, usar `/compact`, o balancear hacia otra subscription.
   - `full since 10-18 04:09`: al 100%; las peticiones conmutan al siguiente provider del pool.
   - `no pace yet`: requiere dos lecturas separadas por al menos 5 minutos durante la última hora.
4. Gráfico de ventana: visualiza la ventana completa desde su inicio hasta su reset en escala 0–100%.
   - Bloques sólidos (`█`): porcentaje consumido registrado (`·` previo a la primera lectura).
   - Puntos (`•`): proyección del ritmo actual desde `┴ now` hacia `┤ reset` (o hacia `▲ full` si satura antes).
   - Marcas temporales de inicio, `now`, `full` y `reset` rotuladas bajo el eje según disponibilidad de espacio.

La modalidad compacta (`5 hud` en `ctrl+alt+u`) sintetiza cada ventana en una sola línea:
`+2.3%/h · full in 14h 25m ⚠` describe idéntico comportamiento que la línea de ritmo completa.

### APIs: facturación por token

Una integración por API (Anthropic API, Gemini API) no posee ventanas de quota fija: se abona por token.
La pantalla detalla peticiones e importes en USD hoy, en 7 días y en 30 días, según los precios de lista
en `prices.json`.

```
Anthropic API
  period  requests  USD
  today          3  $1.20
  7d            10  $4.00*
```

- `*`: ciertas peticiones utilizaron modelos sin precio configurado en `prices.json`, constituyendo un
  límite inferior. Incorporar el precio del modelo regulariza el cálculo.
- `no requests in 30 days`: integración configurada sin tráfico registrado. Es la condición habitual
  hasta registrar y consumir una API key.

### Sessions: desglose de mayor consumo

Cada petición reenvía la conversación íntegra al modelo, por lo que los tokens de una sesión se diferencian en:

- **context re-sent**: input + cache read + cache write, es decir, el historial reenviado en cada turno.
  Se incrementa de manera continua.
- **new output**: texto nuevo generado por el modelo.

```
orchestrator  230.3M tokens · 100% context re-sent
▸ bueno vamos a empezar a fixear cosas, t…  mu-web           98.5M  100% re-sent  00:53
  legacy                                    (before histo…   53.8M   99% re-sent  10-18 03:49
gentle-ai-verify  10.3M tokens · 99% context re-sent
  verify login token (credentials)          mu-web            5.0M   99% re-sent  00:51
```

- Los roles se ordenan por volumen de consumo decreciente (orchestrator y cada subagent), con hasta 5
  sesiones cada uno dentro de los últimos 7 días.
- **Nombre de la sesión**: se resuelve en orden: nombre asignado por el usuario, etiqueta de tarea del
  subagent, mensaje inicial (truncado a 40 caracteres) o, en última instancia, los primeros 8 caracteres del id.
- **`% re-sent` en amarillo**: indica que 90% o más corresponde a historial repetido; sugiere conveniencia
  de ejecutar `/compact` o segmentar la tarea.
- `▸`: cursor de selección. `enter` cierra el panel y conmuta Pi a dicha sesión. Si el archivo local fue
  removido, permanece en pantalla reportando la situación.

### Suggestions: recomendaciones basadas en evidencia

La vista de sugerencias evalúa patrones de uso reales según cuatro reglas de optimización:
- **Large context**: sesiones que reenvían >=120k tokens de context durante >=5 turnos. Proyecta ahorro al compactar o segmentar.
- **Provider switch**: sesiones con alternancia frecuente de provider/modelo que provocaron invalidación masiva de cache.
- **Expensive role**: roles de subagent con salidas breves en modelos de alto costo cuando existe un modelo alternativo probado con costo inferior a la mitad. Pulsar `c` o `enter` genera automáticamente un nuevo profile en `profiles.json` (ej. `mu-privado-opt-gentle-ai-verify`) tras respaldar el archivo (`profiles.json.bak-YYYYMMDDHHMMSS`).
- **Idle quota**: ventanas de subscription con proyección de >=50% sin utilizar al momento del reset mientras otra ventana paralela se satura.

Cada sugerencia identifica la sesión por su alias, muestra una línea explicativa `why:`, y al seleccionarse
despliega evidencia detallada junto a la recomendación `→`. Se aclara siempre que la calidad técnica no se
mide de forma automática, permitiendo evaluar antes de consolidar cambios.

## Mapeo de proveedores e integraciones

El archivo `integrations.json` establece la clasificación: `"kind": "subscription"` deriva a la vista
de subscriptions, mientras que `"kind": "api"` deriva a la vista de APIs. Providers no declarados no se
infieren de forma arbitraria. Los pools (`pool/claude-opus-5-5`) operan como routers lógicos y no como
integraciones: cada consumo se registra bajo el provider real que resolvió la respuesta.
