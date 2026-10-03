#define _GNU_SOURCE
#include <errno.h>
#include <linux/capability.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <linux/securebits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef __NR_fchmodat2
#define __NR_fchmodat2 452
#endif

#define READ (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)
#define WRITE (LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_SYM)
#define DENY (SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))
#define SYSCALL(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1), BPF_STMT(BPF_RET | BPF_K, DENY)
/* Reading extended attributes answers "not supported", which tools like ls take quietly. */
#define NO_XATTR(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EOPNOTSUPP)

static const uint64_t FILE_RIGHTS = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE |
  LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_TRUNCATE;
static int add_path(int ruleset, const char *path, uint64_t rights) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat st;
  if (fstat(fd, &st)) { close(fd); return -1; }
  if (!S_ISDIR(st.st_mode)) rights &= FILE_RIGHTS;
  struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = fd };
  int result = syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  int error = errno;
  close(fd);
  errno = error;
  return result;
}

static int add_paths(int ruleset, const char *paths, int count, uint64_t rights) {
  for (int i = 0; i < count; i++) {
    if (add_path(ruleset, paths, rights)) return -1;
    paths += strlen(paths) + 1;
  }
  return 0;
}

static int drop_capabilities(void) {
  /* Root must not retain ambient machine capabilities in the boxed process. */
  if (geteuid() == 0 && prctl(PR_SET_SECUREBITS, SECBIT_NOROOT | SECBIT_NOROOT_LOCKED |
      SECBIT_NO_SETUID_FIXUP | SECBIT_NO_SETUID_FIXUP_LOCKED, 0, 0, 0)) return -1;
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct empty[2] = { 0 };
  return syscall(__NR_capset, &header, empty);
}

static int filter_syscalls(void) {
#if defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#else
  errno = ENOTSUP;
  return -1;
#endif
  uint32_t self = (uint32_t)getpid();
  struct sock_filter code[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    /* x32 shares the x86_64 arch tag but uses distinct syscall numbers. */
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY),
    /* O_RDONLY|O_TRUNC evades Landlock ABI 1/2 WRITE_FILE checks. */
#ifdef __NR_open
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_open, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, O_TRUNC | O_ACCMODE),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, O_TRUNC, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, O_TRUNC | O_ACCMODE),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, O_TRUNC, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    SYSCALL(__NR_openat2),
    SYSCALL(__NR_truncate),
#ifdef __NR_creat
    SYSCALL(__NR_creat),
#endif
    SYSCALL(__NR_socket),
    SYSCALL(__NR_socketpair),
    SYSCALL(__NR_ptrace),
    SYSCALL(__NR_process_vm_readv),
    SYSCALL(__NR_process_vm_writev),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_kill, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, self, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, DENY),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    SYSCALL(__NR_tkill),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_tgkill, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, self, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, DENY),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    /* Queued signals take the destination pid/tgid in arg 0, not the siginfo pointer. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_rt_sigqueueinfo, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, self, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, DENY),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_rt_tgsigqueueinfo, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, self, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, DENY),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    /* Async fd ownership can signal other processes without a signal syscall. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_fcntl, 0, 6),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETOWN, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETOWN_EX, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETSIG, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    SYSCALL(__NR_pidfd_send_signal),
    SYSCALL(__NR_pidfd_getfd),
    SYSCALL(__NR_name_to_handle_at),
    SYSCALL(__NR_open_by_handle_at),
    SYSCALL(__NR_fanotify_init),
    SYSCALL(__NR_kcmp),
    SYSCALL(__NR_process_madvise),
#ifdef __NR_inotify_init
    SYSCALL(__NR_inotify_init),
#endif
    SYSCALL(__NR_inotify_init1),
    SYSCALL(__NR_sched_setparam),
    SYSCALL(__NR_sched_setscheduler),
    SYSCALL(__NR_sched_setattr),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prlimit64, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, self, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, DENY),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    SYSCALL(__NR_kexec_load),
    SYSCALL(__NR_keyctl),
    SYSCALL(__NR_add_key),
    SYSCALL(__NR_request_key),
    SYSCALL(__NR_io_uring_setup),
    SYSCALL(__NR_io_uring_enter),
    NO_XATTR(__NR_getxattr),
    NO_XATTR(__NR_lgetxattr),
    NO_XATTR(__NR_fgetxattr),
    NO_XATTR(__NR_listxattr),
    NO_XATTR(__NR_llistxattr),
    NO_XATTR(__NR_flistxattr),
    SYSCALL(__NR_setxattr),
    SYSCALL(__NR_lsetxattr),
    SYSCALL(__NR_fsetxattr),
    SYSCALL(__NR_removexattr),
    SYSCALL(__NR_lremovexattr),
    SYSCALL(__NR_fremovexattr),
    SYSCALL(__NR_sethostname),
    SYSCALL(__NR_setdomainname),
    SYSCALL(__NR_clock_settime),
    SYSCALL(__NR_clock_adjtime),
    SYSCALL(__NR_adjtimex),
    SYSCALL(__NR_settimeofday),
    SYSCALL(__NR_syslog),
    SYSCALL(__NR_setpriority),
    SYSCALL(__NR_sched_setaffinity),
#ifdef __NR_iopl
    SYSCALL(__NR_iopl),
    SYSCALL(__NR_ioperm),
#endif
    SYSCALL(__NR_io_uring_register),
    SYSCALL(__NR_mount),
    SYSCALL(__NR_umount2),
    SYSCALL(__NR_pivot_root),
    SYSCALL(__NR_chroot),
    SYSCALL(__NR_setns),
    SYSCALL(__NR_unshare),
    /* Everything a box starts stays in its process group, so stopping the group stops all of it. */
    SYSCALL(__NR_setsid),
    SYSCALL(__NR_setpgid),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    SYSCALL(__NR_bpf),
    SYSCALL(__NR_perf_event_open),
    SYSCALL(__NR_init_module),
    SYSCALL(__NR_finit_module),
    SYSCALL(__NR_delete_module),
    SYSCALL(__NR_reboot),
    SYSCALL(__NR_swapon),
    SYSCALL(__NR_swapoff),
    SYSCALL(__NR_acct),
#ifdef __NR_chmod
    SYSCALL(__NR_chmod),
#endif
    SYSCALL(__NR_fchmod),
    SYSCALL(__NR_fchmodat),
    SYSCALL(__NR_fchmodat2),
#ifdef __NR_chown
    SYSCALL(__NR_chown),
#endif
    SYSCALL(__NR_fchown),
#ifdef __NR_lchown
    SYSCALL(__NR_lchown),
#endif
    SYSCALL(__NR_fchownat),
#ifdef __NR_utime
    SYSCALL(__NR_utime),
    SYSCALL(__NR_utimes),
    SYSCALL(__NR_futimesat),
#endif
    SYSCALL(__NR_utimensat),
    /* clone with namespace flags is forbidden; normal Bun threads remain available. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, 0x7e020000),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, DENY),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    /* No ioctl on host-provided fds, including FS_IOC_SETFLAGS and TIOCSTI. */
    SYSCALL(__NR_ioctl),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(code) / sizeof(*code), .filter = code };
  return syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program);
}

/* Called only in the disposable child process. On any error, exit rather than return to unconstrained JS. */
void box_enter(const char *bin, const char *cwd, const char *reads, int read_count,
               const char *lists, int list_count, const char *writes, int write_count,
               const char *execs, int exec_count, const char *args, int arg_count) {
  const char *stage = "landlock";
  int abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) goto fail;
  uint64_t handled = READ | WRITE | LANDLOCK_ACCESS_FS_EXECUTE |
    LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK;
  if (abi >= 2) handled |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) handled |= LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_ruleset_attr attr = { .handled_access_fs = handled };
  int ruleset = syscall(__NR_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (ruleset < 0) goto fail;
  stage = "path grants";
  if (add_paths(ruleset, reads, read_count, READ) ||
      add_paths(ruleset, lists, list_count, LANDLOCK_ACCESS_FS_READ_DIR) ||
      add_paths(ruleset, writes, write_count, READ | WRITE | (abi >= 3 ? LANDLOCK_ACCESS_FS_TRUNCATE : 0)) ||
      add_paths(ruleset, execs, exec_count, READ | LANDLOCK_ACCESS_FS_EXECUTE) ||
      add_path(ruleset, reads, LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE) ||
      add_path(ruleset, bin, LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE)) goto fail;
  stage = "working directory";
  if (chdir(cwd)) goto fail;
  stage = "no new privileges";
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) goto fail;
  stage = "drop capabilities";
  if (drop_capabilities()) goto fail;
  stage = "landlock enforcement";
  if (syscall(__NR_landlock_restrict_self, ruleset, 0)) goto fail;
  close(ruleset);
  stage = "seccomp enforcement";
  if (filter_syscalls()) goto fail;
  if (arg_count < 0 || arg_count > 4096) goto fail;
  char *argv[arg_count + 2];
  argv[arg_count + 1] = NULL;
  argv[0] = (char *)bin;
  for (int i = 0; i < arg_count; i++) {
    argv[i + 1] = (char *)args;
    args += strlen(args) + 1;
  }
  stage = "execution";
  execv(bin, argv);
fail:
  fprintf(stderr, "box unavailable at %s: ", stage);
  perror("");
  _exit(125);
}

