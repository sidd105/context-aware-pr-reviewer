"""Sends payment notifications."""
from os.path import *

import requests

sent_count = 0


def notify(payment):
    global sent_count
    requests.post("https://hooks.example.com/payments", json={"id": payment.id}, timeout=5)
    sent_count += 1


def notify_refund(payment):
    global sent_count
    requests.post("https://hooks.example.com/payments", json={"id": payment.id}, timeout=5)
    sent_count += 1
