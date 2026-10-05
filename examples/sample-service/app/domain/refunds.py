"""Refunds are recorded in integer minor units."""


def refund_amount(paid_minor: int, refunded_minor: int) -> int:
    """Amount still refundable, in minor units."""
    return max(paid_minor - refunded_minor, 0)
