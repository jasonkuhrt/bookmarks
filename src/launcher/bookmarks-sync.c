/*
 * bookmarks-sync: the program launchd runs for the bookmarks daemon.
 *
 * macOS checks a file read against the process responsible for it. A launchd job is
 * responsible for itself, and its children answer for it. Safari's Bookmarks.plist and
 * Chrome's profile need Full Disk Access, so the grant goes to this small, signed launcher
 * rather than to bun, whose path changes with every bun upgrade. It runs its arguments as a
 * child (never exec, which would make bun the responsible process), forwards stop signals,
 * and exits with the child's status.
 */

#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>

extern char **environ;

static pid_t child = 0;

static void forward(int signal_number) {
  if (child > 0) kill(child, signal_number);
}

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: bookmarks-sync <program> [arguments...]\n");
    return 64;
  }

  signal(SIGTERM, forward);
  signal(SIGINT, forward);
  signal(SIGHUP, forward);

  int spawn_error = posix_spawnp(&child, argv[1], NULL, NULL, argv + 1, environ);
  if (spawn_error != 0) {
    errno = spawn_error;
    perror("bookmarks-sync: cannot start the daemon");
    return 127;
  }

  int status = 0;
  while (waitpid(child, &status, 0) == -1) {
    if (errno != EINTR) {
      perror("bookmarks-sync: lost the daemon");
      return 1;
    }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 128 + WTERMSIG(status);
}
