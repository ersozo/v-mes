FROM nodered/node-red:5.0.8

# S7 sürücüsü (resmi imajın önerdiği yöntem: Node-RED kurulum dizinine eklenir)
RUN npm install --no-audit --no-fund --omit=dev node-red-contrib-s7@3.1.3

COPY settings.js /usr/src/node-red/mes-settings.js

# Imajın entrypoint'i argümanları red.js'e aktarır (--userDir /data zaten verilir)
CMD ["--settings", "/usr/src/node-red/mes-settings.js"]
