import io

path = r"src/controllers/dashboard.controllers.ts"
with io.open(path, "r", encoding="utf-8") as f:
    content = f.read()

# 1) Quitar la '/' de la clase de caracteres del esc():
#    /[;"/\n]/  ->  /[;"\n]/   (la '/' no es metacaracter en CSV de ';')
old_re = r'/[;"/\n]/'
new_re = r'/[;"\n]/'
assert content.count(old_re) == 1, f"esperado 1 ocurrencia de {old_re}, halladas {content.count(old_re)}"
content = content.replace(old_re, new_re)

# 2) Eliminar las líneas sobrantes (void 0; + }; extra) tras el cierre de esc()
stray = "\n  void 0;\n  };\n"
assert content.count(stray) == 1, f"esperado 1 bloque stray, hallados {content.count(stray)}"
content = content.replace(stray, "\n")

with io.open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("OK: regex corregido y lineas sobrantes eliminadas.")
