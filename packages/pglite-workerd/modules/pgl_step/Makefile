# The hybrid step as a host import: linked into the workerd backend
# (wasm.nu's MODULES), never a loadable module.
MODULE_big = pgl_step
OBJS = pgl_step.o
PGFILEDESC = "pgl_step - a machine's step, run by the host"

subdir = contrib/pgl_step
top_builddir = ../..
include $(top_builddir)/src/Makefile.global
include $(top_srcdir)/contrib/contrib-global.mk
