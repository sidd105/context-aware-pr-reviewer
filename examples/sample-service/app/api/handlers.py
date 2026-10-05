import sqlite3

import yaml
from flask import Flask, jsonify, request

app = Flask(__name__)


@app.route("/payments/<payment_id>")
def get_payment(payment_id):
    conn = sqlite3.connect("payments.db")
    row = conn.execute(f"SELECT * FROM payments WHERE id = '{payment_id}'").fetchone()
    return jsonify(row)


@app.route("/payments", methods=["POST"])
def create_payment():
    try:
        config = yaml.load(request.data)
        print("creating payment", config)
        return jsonify({"ok": True})
    except:
        return str(sys.exc_info()), 500
