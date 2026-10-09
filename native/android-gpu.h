#ifndef SLIM_NATIVE_ANDROID_GPU_H
#define SLIM_NATIVE_ANDROID_GPU_H

#if SLIM_GPU_RENDERER

#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <android/log.h>
#include <stddef.h>

#define SLIM_ANDROID_GPU_LOG "SLIM-GPU"

static EGLDisplay slim_android_gpu_display = EGL_NO_DISPLAY;
static EGLConfig slim_android_gpu_config;
static EGLContext slim_android_gpu_context = EGL_NO_CONTEXT;
static EGLSurface slim_android_gpu_surface = EGL_NO_SURFACE;
static ANativeWindow *slim_android_gpu_window;
static uint32_t slim_android_gpu_window_generation;
static int slim_android_gpu_native_visual;
static GLuint slim_android_gpu_program;
static GLuint slim_android_gpu_vbo;
static GLint slim_android_gpu_position_attribute = -1;
static GLint slim_android_gpu_color_attribute = -1;
static int slim_android_gpu_surface_width;
static int slim_android_gpu_surface_height;
static int slim_android_gpu_view_left;
static int slim_android_gpu_view_top;
static int slim_android_gpu_view_width;
static int slim_android_gpu_view_height;
static int slim_android_gpu_target_ready;
static int slim_android_gpu_frame_failed;
static int slim_android_gpu_logged_renderer;
static int slim_android_gpu_swap_interval_set;

static void slim_android_gpu_log_egl(const char *where, EGLint error) {
  __android_log_print(ANDROID_LOG_ERROR, SLIM_ANDROID_GPU_LOG,
                      "%s failed (EGL 0x%x)", where, (unsigned int)error);
}

static void slim_android_gpu_log_gl(const char *where, GLenum error) {
  __android_log_print(ANDROID_LOG_ERROR, SLIM_ANDROID_GPU_LOG,
                      "%s failed (GL 0x%x)", where, (unsigned int)error);
}

static void slim_android_gpu_reset_surface_dimensions(void) {
  slim_android_gpu_surface_width = 0;
  slim_android_gpu_surface_height = 0;
  slim_android_gpu_view_left = 0;
  slim_android_gpu_view_top = 0;
  slim_android_gpu_view_width = 0;
  slim_android_gpu_view_height = 0;
  slim_android_gpu_target_ready = 0;
  slim_android_gpu_swap_interval_set = 0;
}

static void slim_android_gpu_drop_surface(int release_window) {
  if (slim_android_gpu_display != EGL_NO_DISPLAY &&
      slim_android_gpu_surface != EGL_NO_SURFACE) {
    (void)eglMakeCurrent(slim_android_gpu_display, EGL_NO_SURFACE,
                         EGL_NO_SURFACE, EGL_NO_CONTEXT);
    (void)eglDestroySurface(slim_android_gpu_display, slim_android_gpu_surface);
    slim_android_gpu_surface = EGL_NO_SURFACE;
  }
  slim_android_gpu_reset_surface_dimensions();
  if (release_window && slim_android_gpu_window) {
    ANativeWindow_release(slim_android_gpu_window);
    slim_android_gpu_window = 0;
    slim_android_gpu_window_generation = 0;
  }
}

static void slim_android_gpu_reset_context(void) {
  EGLDisplay display = slim_android_gpu_display;
  slim_android_gpu_drop_surface(1);
  if (display != EGL_NO_DISPLAY) {
    if (slim_android_gpu_context != EGL_NO_CONTEXT) {
      (void)eglDestroyContext(display, slim_android_gpu_context);
    }
    (void)eglTerminate(display);
  }
  slim_android_gpu_display = EGL_NO_DISPLAY;
  slim_android_gpu_config = 0;
  slim_android_gpu_context = EGL_NO_CONTEXT;
  slim_android_gpu_program = 0;
  slim_android_gpu_vbo = 0;
  slim_android_gpu_position_attribute = -1;
  slim_android_gpu_color_attribute = -1;
  slim_android_gpu_native_visual = 0;
  slim_android_gpu_logged_renderer = 0;
}

static int slim_android_gpu_init_context(void) {
  static const EGLint config_attributes[] = {
      EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
      EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
      EGL_RED_SIZE, 8,
      EGL_GREEN_SIZE, 8,
      EGL_BLUE_SIZE, 8,
      EGL_ALPHA_SIZE, 8,
      EGL_DEPTH_SIZE, 0,
      EGL_STENCIL_SIZE, 0,
      EGL_NONE};
  static const EGLint context_attributes[] = {
      EGL_CONTEXT_CLIENT_VERSION, 2,
      EGL_NONE};
  EGLint major = 0, minor = 0, config_count = 0;

  if (slim_android_gpu_display != EGL_NO_DISPLAY) return 1;
  slim_android_gpu_display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  if (slim_android_gpu_display == EGL_NO_DISPLAY) {
    slim_android_gpu_log_egl("eglGetDisplay", eglGetError());
    return 0;
  }
  if (!eglInitialize(slim_android_gpu_display, &major, &minor)) {
    EGLint error = eglGetError();
    slim_android_gpu_log_egl("eglInitialize", error);
    slim_android_gpu_reset_context();
    return 0;
  }
  if (!eglBindAPI(EGL_OPENGL_ES_API) ||
      !eglChooseConfig(slim_android_gpu_display, config_attributes,
                       &slim_android_gpu_config, 1, &config_count) ||
      config_count != 1 ||
      !eglGetConfigAttrib(slim_android_gpu_display, slim_android_gpu_config,
                          EGL_NATIVE_VISUAL_ID, &slim_android_gpu_native_visual)) {
    EGLint error = eglGetError();
    slim_android_gpu_log_egl("EGL config setup", error);
    slim_android_gpu_reset_context();
    return 0;
  }
  slim_android_gpu_context = eglCreateContext(slim_android_gpu_display,
                                               slim_android_gpu_config,
                                               EGL_NO_CONTEXT,
                                               context_attributes);
  if (slim_android_gpu_context == EGL_NO_CONTEXT) {
    EGLint error = eglGetError();
    slim_android_gpu_log_egl("eglCreateContext", error);
    slim_android_gpu_reset_context();
    return 0;
  }
  return 1;
}

static GLuint slim_android_gpu_compile_shader(GLenum type, const char *source) {
  GLuint shader = glCreateShader(type);
  GLint compiled = GL_FALSE;
  if (!shader) return 0;
  glShaderSource(shader, 1, &source, 0);
  glCompileShader(shader);
  glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
  if (compiled != GL_TRUE) {
    char message[512];
    GLsizei length = 0;
    glGetShaderInfoLog(shader, (GLsizei)sizeof(message), &length, message);
    __android_log_print(ANDROID_LOG_ERROR, SLIM_ANDROID_GPU_LOG,
                        "shader compile failed: %.*s", (int)length, message);
    glDeleteShader(shader);
    return 0;
  }
  return shader;
}

static int slim_android_gpu_create_program(void) {
  static const char vertex_source[] =
      "attribute vec2 a_position;\n"
      "attribute vec4 a_color;\n"
      "varying vec4 v_color;\n"
      "void main() { gl_Position = vec4(a_position, 0.0, 1.0); v_color = a_color; }\n";
  static const char fragment_source[] =
      "precision mediump float;\n"
      "varying vec4 v_color;\n"
      "void main() { gl_FragColor = v_color; }\n";
  GLuint vertex_shader = slim_android_gpu_compile_shader(GL_VERTEX_SHADER, vertex_source);
  GLuint fragment_shader = slim_android_gpu_compile_shader(GL_FRAGMENT_SHADER, fragment_source);
  GLuint program = 0;
  GLint linked = GL_FALSE;

  if (!vertex_shader || !fragment_shader) goto fail;
  program = glCreateProgram();
  if (!program) goto fail;
  glAttachShader(program, vertex_shader);
  glAttachShader(program, fragment_shader);
  glBindAttribLocation(program, 0, "a_position");
  glBindAttribLocation(program, 1, "a_color");
  glLinkProgram(program);
  glGetProgramiv(program, GL_LINK_STATUS, &linked);
  if (linked != GL_TRUE) {
    char message[512];
    GLsizei length = 0;
    glGetProgramInfoLog(program, (GLsizei)sizeof(message), &length, message);
    __android_log_print(ANDROID_LOG_ERROR, SLIM_ANDROID_GPU_LOG,
                        "shader link failed: %.*s", (int)length, message);
    goto fail;
  }
  glDeleteShader(vertex_shader);
  vertex_shader = 0;
  glDeleteShader(fragment_shader);
  fragment_shader = 0;
  slim_android_gpu_position_attribute = glGetAttribLocation(program, "a_position");
  slim_android_gpu_color_attribute = glGetAttribLocation(program, "a_color");
  if (slim_android_gpu_position_attribute < 0 || slim_android_gpu_color_attribute < 0) goto fail;
  slim_android_gpu_program = program;
  glUseProgram(program);
  glGenBuffers(1, &slim_android_gpu_vbo);
  if (!slim_android_gpu_vbo) goto fail;
  glEnableVertexAttribArray((GLuint)slim_android_gpu_position_attribute);
  glEnableVertexAttribArray((GLuint)slim_android_gpu_color_attribute);
  glBindBuffer(GL_ARRAY_BUFFER, slim_android_gpu_vbo);
  glVertexAttribPointer((GLuint)slim_android_gpu_position_attribute, 2, GL_FLOAT, GL_FALSE,
                        (GLsizei)sizeof(SlimGpuVertex), (const void *)(uintptr_t)0);
  glVertexAttribPointer((GLuint)slim_android_gpu_color_attribute, 4, GL_UNSIGNED_BYTE, GL_TRUE,
                        (GLsizei)sizeof(SlimGpuVertex),
                        (const void *)(uintptr_t)offsetof(SlimGpuVertex, rgba));
  return 1;

fail:
  if (program) glDeleteProgram(program);
  if (vertex_shader) glDeleteShader(vertex_shader);
  if (fragment_shader) glDeleteShader(fragment_shader);
  slim_android_gpu_program = 0;
  slim_android_gpu_vbo = 0;
  slim_android_gpu_position_attribute = -1;
  slim_android_gpu_color_attribute = -1;
  return 0;
}

static int slim_android_gpu_prepare(ANativeWindow *window, uint32_t generation) {
  EGLint surface_width = 0, surface_height = 0;
  int left, top, view_width, view_height;
  EGLBoolean current;
  if (!window) return 0;
  slim_android_gpu_target_ready = 0;

  if (!slim_android_gpu_init_context()) return 0;
  if (slim_android_gpu_window != window ||
      slim_android_gpu_window_generation != generation) {
    slim_android_gpu_drop_surface(1);
    ANativeWindow_acquire(window);
    slim_android_gpu_window = window;
    slim_android_gpu_window_generation = generation;
  }
  if (slim_android_gpu_surface == EGL_NO_SURFACE) {
    int result = ANativeWindow_setBuffersGeometry(window, 0, 0,
                                                   slim_android_gpu_native_visual);
    if (result != 0) {
      __android_log_print(ANDROID_LOG_ERROR, SLIM_ANDROID_GPU_LOG,
                          "ANativeWindow_setBuffersGeometry failed (%d)", result);
      return 0;
    }
    slim_android_gpu_surface = eglCreateWindowSurface(slim_android_gpu_display,
                                                       slim_android_gpu_config,
                                                       window, 0);
    if (slim_android_gpu_surface == EGL_NO_SURFACE) {
      slim_android_gpu_log_egl("eglCreateWindowSurface", eglGetError());
      return 0;
    }
  }
  if (eglGetCurrentContext() != slim_android_gpu_context ||
      eglGetCurrentSurface(EGL_DRAW) != slim_android_gpu_surface ||
      eglGetCurrentSurface(EGL_READ) != slim_android_gpu_surface) {
    current = eglMakeCurrent(slim_android_gpu_display, slim_android_gpu_surface,
                             slim_android_gpu_surface, slim_android_gpu_context);
    if (!current) {
      EGLint error = eglGetError();
      slim_android_gpu_log_egl("eglMakeCurrent", error);
      if (error == EGL_CONTEXT_LOST) slim_android_gpu_reset_context();
      else slim_android_gpu_drop_surface(1);
      return 0;
    }
  }
  if (!slim_android_gpu_program && !slim_android_gpu_create_program()) {
    __android_log_print(ANDROID_LOG_ERROR, SLIM_ANDROID_GPU_LOG,
                        "failed to create GLES2 program and VBO");
    return 0;
  }
  if (!eglQuerySurface(slim_android_gpu_display, slim_android_gpu_surface,
                       EGL_WIDTH, &surface_width) ||
      !eglQuerySurface(slim_android_gpu_display, slim_android_gpu_surface,
                       EGL_HEIGHT, &surface_height) ||
      surface_width <= 0 || surface_height <= 0 ||
      !slim_framebuffer_size_valid(surface_width, surface_height)) {
    EGLint error = eglGetError();
    slim_android_gpu_log_egl("eglQuerySurface", error);
    if (error == EGL_CONTEXT_LOST) slim_android_gpu_reset_context();
    else slim_android_gpu_drop_surface(1);
    return 0;
  }
  slim_fit_viewport(surface_width, surface_height, &left, &top,
                    &view_width, &view_height);
  if (!slim_framebuffer_size_valid(view_width, view_height)) return 0;

  slim_android_gpu_surface_width = surface_width;
  slim_android_gpu_surface_height = surface_height;
  slim_android_gpu_view_left = left;
  slim_android_gpu_view_top = top;
  slim_android_gpu_view_width = view_width;
  slim_android_gpu_view_height = view_height;
  if (!slim_android_gpu_swap_interval_set) {
    if (eglSwapInterval(slim_android_gpu_display, 1) != EGL_TRUE) {
      __android_log_print(ANDROID_LOG_WARN, SLIM_ANDROID_GPU_LOG,
                          "eglSwapInterval(1) unsupported (EGL 0x%x)",
                          (unsigned int)eglGetError());
    }
    slim_android_gpu_swap_interval_set = 1;
  }
  if (!slim_android_gpu_logged_renderer) {
    const GLubyte *renderer = glGetString(GL_RENDERER);
    const GLubyte *version = glGetString(GL_VERSION);
    __android_log_print(ANDROID_LOG_INFO, SLIM_ANDROID_GPU_LOG,
                        "GLES renderer=%s version=%s",
                        renderer ? (const char *)renderer : "unknown",
                        version ? (const char *)version : "unknown");
    slim_android_gpu_logged_renderer = 1;
  }
  slim_android_gpu_target_ready = 1;
  return 1;
}

static void slim_android_gpu_detach_window(void) {
  slim_android_gpu_drop_surface(1);
}

static int slim_gpu_begin_target(void) {
  GLenum error;
  slim_android_gpu_frame_failed = 0;
  if (slim_android_gpu_display == EGL_NO_DISPLAY ||
      slim_android_gpu_context == EGL_NO_CONTEXT ||
      slim_android_gpu_surface == EGL_NO_SURFACE ||
      !slim_android_gpu_program || !slim_android_gpu_vbo ||
      slim_android_gpu_surface_width <= 0 || slim_android_gpu_surface_height <= 0 ||
      slim_android_gpu_view_width <= 0 || slim_android_gpu_view_height <= 0) {
    slim_android_gpu_frame_failed = 1;
    slim_android_gpu_target_ready = 0;
    return 0;
  }

  slim_bind_framebuffer(0, slim_android_gpu_view_width,
                        slim_android_gpu_view_height, slim_android_gpu_view_width);
  glDisable(GL_SCISSOR_TEST);
  glDisable(GL_CULL_FACE);
  glDisable(GL_DEPTH_TEST);
  glDisable(GL_DITHER);
  glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
  glViewport(slim_android_gpu_view_left,
             slim_android_gpu_surface_height - slim_android_gpu_view_top - slim_android_gpu_view_height,
             slim_android_gpu_view_width, slim_android_gpu_view_height);
  glEnable(GL_BLEND);
  glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA,
                      GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
  glUseProgram(slim_android_gpu_program);
  glBindBuffer(GL_ARRAY_BUFFER, slim_android_gpu_vbo);
  error = glGetError();
  if (error != GL_NO_ERROR) {
    slim_android_gpu_log_gl("begin target", error);
    slim_android_gpu_frame_failed = 1;
    slim_android_gpu_target_ready = 0;
    return 0;
  }
  return 1;
}

static int slim_gpu_flush_vertices(const SlimGpuVertex *vertices, uint32_t count) {
  GLenum error;
  const GLsizeiptr capacity_bytes = (GLsizeiptr)SLIM_GPU_VERTEX_CAPACITY *
                                    (GLsizeiptr)sizeof(SlimGpuVertex);
  GLsizeiptr used_bytes;
  if (!vertices || !count || count > SLIM_GPU_VERTEX_CAPACITY || count % 3u != 0u ||
      slim_android_gpu_frame_failed || !slim_android_gpu_target_ready ||
      !slim_android_gpu_vbo || !slim_android_gpu_program) {
    slim_android_gpu_frame_failed = 1;
    return 0;
  }
  used_bytes = (GLsizeiptr)count * (GLsizeiptr)sizeof(SlimGpuVertex);
  glUseProgram(slim_android_gpu_program);
  glBindBuffer(GL_ARRAY_BUFFER, slim_android_gpu_vbo);
  glBufferData(GL_ARRAY_BUFFER, capacity_bytes, 0, GL_STREAM_DRAW);
  glBufferSubData(GL_ARRAY_BUFFER, 0, used_bytes, vertices);
  glVertexAttribPointer((GLuint)slim_android_gpu_position_attribute, 2, GL_FLOAT, GL_FALSE,
                        (GLsizei)sizeof(SlimGpuVertex), (const void *)(uintptr_t)0);
  glVertexAttribPointer((GLuint)slim_android_gpu_color_attribute, 4, GL_UNSIGNED_BYTE, GL_TRUE,
                        (GLsizei)sizeof(SlimGpuVertex),
                        (const void *)(uintptr_t)offsetof(SlimGpuVertex, rgba));
  glDrawArrays(GL_TRIANGLES, 0, (GLsizei)count);
  error = glGetError();
  if (error != GL_NO_ERROR) {
    slim_android_gpu_log_gl("vertex batch", error);
    slim_android_gpu_frame_failed = 1;
    return 0;
  }
  return 1;
}

static int slim_android_gpu_present(void) {
  if (!slim_android_gpu_target_ready || slim_android_gpu_frame_failed) return 0;
  if (!eglSwapBuffers(slim_android_gpu_display, slim_android_gpu_surface)) {
    EGLint error = eglGetError();
    slim_android_gpu_log_egl("eglSwapBuffers", error);
    slim_android_gpu_target_ready = 0;
    if (error == EGL_CONTEXT_LOST) slim_android_gpu_reset_context();
    else slim_android_gpu_drop_surface(1);
    return 0;
  }
  slim_android_gpu_target_ready = 0;
  return 1;
}

static void slim_android_gpu_shutdown(void) {
  EGLDisplay display = slim_android_gpu_display;
  if (display != EGL_NO_DISPLAY && slim_android_gpu_context != EGL_NO_CONTEXT &&
      slim_android_gpu_surface != EGL_NO_SURFACE &&
      eglMakeCurrent(display, slim_android_gpu_surface,
                     slim_android_gpu_surface, slim_android_gpu_context)) {
    if (slim_android_gpu_vbo) glDeleteBuffers(1, &slim_android_gpu_vbo);
    if (slim_android_gpu_program) glDeleteProgram(slim_android_gpu_program);
  }
  slim_android_gpu_reset_context();
}

#endif /* SLIM_GPU_RENDERER */

#endif /* SLIM_NATIVE_ANDROID_GPU_H */
