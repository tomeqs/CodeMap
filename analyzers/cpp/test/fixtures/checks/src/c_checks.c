#include <stdio.h>
#include <string.h>

static void clear(char* buffer, const char* name) {
    char local[16];
    memset(buffer, 0, sizeof(buffer));
    memset(local, 0, sizeof(local));
    if (name == "admin") {
        strcpy(local, name);
    }
    if (strcmp(name, "admin") == 0) {
        sprintf(local, "%s", name);
    }
}

int read_line(char* line, int c) {
    if (c = getchar()) {
        gets(line);
    }
    return c;
}
