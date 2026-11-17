import os
import requests
from flask import Flask, jsonify, request

app = Flask(__name__)
NOTES = {}


@app.get("/health")
def health():
    return jsonify(ok=True)


@app.post("/notes")
def create_note():
    data = request.get_json(force=True)
    note_id = len(NOTES) + 1
    NOTES[note_id] = {"id": note_id, "text": data.get("text", "")}
    return jsonify(NOTES[note_id]), 201


@app.get("/weather/<city>")
def weather(city):
    r = requests.get(f"https://wttr.in/{city}?format=j1")
    return jsonify(r.json()["current_condition"][0])


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5000)))
