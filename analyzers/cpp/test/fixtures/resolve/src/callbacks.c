typedef int (*handler_fn)(int);

static int on_open(int code) { return code; }
static int on_close(int code) { return -code; }

struct handlers {
    handler_fn open;
    handler_fn close;
};

static const struct handlers table = { on_open, on_close };

int dispatch(int code) {
    return table.open(code);
}
