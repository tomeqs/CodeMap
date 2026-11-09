from flask import Flask


def create_app() -> Flask:
    app = Flask(__name__)
    from legacy.catalog import catalog

    app.register_blueprint(catalog, url_prefix="/catalog")
    return app
