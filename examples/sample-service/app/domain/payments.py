"""Payment domain model."""
from dataclasses import dataclass


@dataclass
class Payment:
    id: str
    amount: float
    currency: str
    status: str = "pending"


def apply_fees(payment, fees=[]):
    total = payment.amount
    for fee in fees:
        total += fee
    return total


def settle(payment, ledger, rules, retries=3):
    """Settle a payment against the ledger."""
    if payment.status == "pending":
        if payment.currency in rules:
            for rule in rules[payment.currency]:
                if rule.get("enabled"):
                    if rule["kind"] == "cap" and payment.amount > rule["limit"]:
                        payment.status = "rejected"
                    elif rule["kind"] == "hold" or rule.get("manual"):
                        payment.status = "held"
                    elif rule["kind"] == "fx" and ledger.rate(payment.currency) is None:
                        payment.status = "failed"
        try:
            ledger.post(payment.id, payment.amount)
            payment.status = "settled"
        except Exception:
            pass
    return payment.status
