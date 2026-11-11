# 🚀 ¡Salió ai-balancer v0.3.0: Nuevo Instalador Interactivo con Capibara Guía! 🦦⚖️

Buenas comunidad! 👋 Les traigo una actualización enorme de **ai-balancer**, la herramienta open-source en TypeScript para balancear y automatizar tus suscripciones y modelos de IA sin quedarte nunca sin cuota.

Para esta versión **v0.3.0** nos enfocamos en que configurar tus pools y agentes no sea un dolor de cabeza lleno de JSONs manuales. ¡Ahora es un paseo guiado paso a paso!

---

## 🌟 ¿Qué hay de nuevo en la v0.3.0?

### 🦦 1. Conocé a la Capibara del Balanceador
Le pusimos cariño y alma al instalador: sumamos una mascota en **pixel-art** con una balanza animada que respira, parpadea y reacciona a tus elecciones en tiempo real. ¡El setup ahora tiene personalidad! *(Y para los que prefieren cero distracciones, respeta `prefers-reduced-motion` automáticamente)*.

### 🖥️ 2. Hub de Instalación Interactivo (Consola TUI y Web en `/installer`)
Ahora con solo ejecutar:
```bash
/balancer setup
```
Podés elegir si querés configurarlo desde la terminal o desde tu navegador en **`http://127.0.0.1:8787/installer`**:
* 📑 **Layout de 3 columnas:** Vista de tu camino (paso a paso), guía conversacional en el centro y panel de ayuda detallada a la derecha con explicaciones claras (qué es, para qué sirve y qué archivo toca).
* 💡 **Cero tecnicismos:** Te habla en lenguaje humano (*Suscripción*, *Respaldo*, *Tarea del agente*, *Estrategia*).

### 🌐 3. Reenvío en LAN y Acceso Remoto desde otra PC
¿Corrés tu entorno en un servidor o máquina remota por SSH? 
Ahora el instalador web te da opciones al vuelo:
* 🔑 **Túnel SSH:** Comando listo para reenviar a tu localhost.
* 📶 **Reenvío LAN directo:** Activás el forwarder con una tecla (`F`) y abrís el instalador directamente desde el navegador de tu laptop o celular en la misma red local.

### 🧠 4. Búsqueda Profunda de Roles con IA (Deep Analysis)
¿No sabés qué modelo asignarle a cada tarea para no fundirte la cuota?
* ⚡ **Asignar recomendado:** En 0 segundos y sin gastar tokens.
* 🔬 **Búsqueda profunda:** Consulta a un modelo asesor para analizar benchmarks, capacidades de contexto y costos, asignando el modelo ideal para cada rol (explorador, escritor, verificador, reviews). Te muestra el progreso en vivo y cuánto uso consumió la consulta.

### 🛡️ 5. Resumen Humano y Deshacer en 1 Clic
* 📋 **Antes de tocar nada:** Te muestra un resumen narrativo de qué va a hacer con tus suscripciones.
* 🔒 **No se aplica nada hasta que confirmes.**
* 💾 **Copias fechadas de seguridad:** Guarda respaldos `.bak` sin pisar nada anterior.
* ⏪ **Deshacer todo:** Si no te gustó el resultado, volvés al estado exacto anterior con un solo botón.

---

## 🚀 Probalo en tu entorno

```bash
# Abrir el instalador interactivo guiado
/balancer setup

# Modo express para terminal
/balancer dummy
```

🔗 **Repositorio GitHub:** [https://github.com/3lAngel0/balanceria](https://github.com/3lAngel0/balanceria)

Si les sirve y les copa el laburo, **¡dejarnos una estrellita en GitHub nos ayuda un montón!** ⭐
Cualquier feedback, sugerencia o idea de mejora es más que bienvenida acá en el chat o en las issues. ¡Los leo! 🙌
