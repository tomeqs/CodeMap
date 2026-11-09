import typer

from worker.tasks import nightly_report, send_receipt

cli = typer.Typer()


@cli.command()
def resend(order_id: int, cents: int) -> None:
    send_receipt.delay(order_id, cents)


@cli.command()
def report() -> None:
    nightly_report.apply_async(countdown=10)


if __name__ == "__main__":
    cli()
