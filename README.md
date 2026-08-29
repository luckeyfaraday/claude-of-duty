# Hijacked Web Viewer

Browser-based Three.js viewer for the Hijacked map export.

## Run the viewer

From the repository root:

```powershell
python -m http.server 8000 --directory export/web
```

Then open <http://localhost:8000>.

## Regenerate the scene

Python 3 is required. The composer uses only the standard library.

```powershell
python .tools/compose_scene.py
```

This rebuilds `export/web/hijacked.gltf` and `export/web/hijacked.bin` from the
world geometry under `export/maps/mp` and the OBJ/MTL assets under
`export/model_export`.
