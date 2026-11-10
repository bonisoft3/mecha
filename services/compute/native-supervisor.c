#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 3) {
    fputs("usage: supervisor parent-pid executable [args...]\n", stderr);
    return 2;
  }
  char *end;
  errno = 0;
  long parent = strtol(argv[1], &end, 10);
  if (errno || *end || parent < 1 || (pid_t)parent != parent) {
    fputs("invalid parent pid\n", stderr);
    return 2;
  }
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) {
    perror("prctl");
    return 1;
  }
  if (getppid() != (pid_t)parent) {
    fputs("parent exited before supervision\n", stderr);
    return 1;
  }
  execv(argv[2], &argv[2]);
  perror("execv");
  return 1;
}
