# StemSplit: lokale Engine (Linux)

Trennt Songs direkt auf deinem Computer statt auf Hugging Face: kein Upload ins Internet, kein Tageslimit.
Die App auf deinem Computer schickt den Song an dieses kleine Programm, und das gibt die Spuren zurück.

## Einmalig einrichten

1. ffmpeg und Python-Umgebungen installieren:
   ```
   sudo apt install ffmpeg python3-venv
   ```
2. Den Ordner `local-engine` irgendwohin kopieren, z. B. nach `~/stemsplit-local`.

## Starten

```
cd ~/stemsplit-local
bash start.sh
```

- **Beim ersten Start** richtet das Skript alles selbst ein (PyTorch und Demucs, ein paar Minuten).
  Mit NVIDIA-Grafikkarte nutzt es automatisch die GPU, sonst den Prozessor.
- Wenn `StemSplit local engine is running on http://127.0.0.1:8765` erscheint, läuft es.
  Das Terminalfenster offen lassen. Beenden mit **Strg+C**.
- Das **erste Trennen pro Modell** lädt das Modell einmalig herunter (ca. 80 MB, beim besten Modell ca. 320 MB).

## In der App einstellen

1. StemSplit **auf dem Computer** öffnen (Chrome oder Firefox).
2. **Settings → Separation engine → This computer**, dann **Save & test connection**.
3. Chrome fragt einmal, ob die Seite auf **Geräte in deinem lokalen Netzwerk** zugreifen darf: **Zulassen**.
   (Falls du versehentlich blockiert hast: Schloss-Symbol links in der Adresszeile → Website-Einstellungen → Lokaler Netzwerkzugriff → Zulassen.)
4. Auf dem Separate-Tab das Modell wählen:
   - **6 stems**: Gesang, Drums, Bass, Gitarre, Klavier, Rest
   - **4 stems (fastest)**: am schnellsten
   - **4 stems, best quality**: beste Qualität, etwa 4× langsamer

Zurück zu Hugging Face: einfach wieder **Settings → Hugging Face**.

## Wie lange dauert es?

Grob für einen 4-Minuten-Song: mit NVIDIA-Grafikkarte unter 30 Sekunden, auf dem Prozessor eines aktuellen Laptops
etwa 1–4 Minuten, mit „best quality“ entsprechend länger.

## Gut zu wissen

- Die Engine lauscht nur auf `127.0.0.1`, also nur auf diesem Computer. Andere Geräte im WLAN kommen nicht ran.
- Die Songs landen nur kurz in einem temporären Ordner und werden nach dem Trennen bzw. nach einer Stunde gelöscht.
- Auf dem **Handy** geht „This computer“ nicht, dort weiter Hugging Face nutzen. Die fertigen Songs kannst du per
  **Export library** vom Computer aufs Handy bringen.
- Anderer Port: `bash start.sh --port 9000` und in der App die Adresse anpassen.
