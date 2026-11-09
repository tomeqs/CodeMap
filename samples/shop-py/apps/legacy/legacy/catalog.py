from flask import Blueprint, jsonify

catalog = Blueprint("catalog", __name__)

PRODUCTS = {"a": "Apple", "b": "Banana"}


@catalog.get("/")
def list_products():
    return jsonify(sorted(PRODUCTS))


@catalog.route("/<sku>", methods=["GET", "HEAD"])
def show_product(sku, fields=[]):
    """The mutable default argument is the sample's check finding."""
    return jsonify({"sku": sku, "name": PRODUCTS.get(sku), "fields": fields})


@catalog.errorhandler(404)
def not_found(error):
    return jsonify({"error": "not found"}), 404
