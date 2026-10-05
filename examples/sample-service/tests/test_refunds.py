from app.domain.refunds import refund_amount


def test_refund_never_negative():
    assert refund_amount(100, 150) == 0
