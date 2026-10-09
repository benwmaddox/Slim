#include <aaudio/AAudio.h>
#include <android/input.h>
#include <android/looper.h>
#include <android/native_activity.h>
#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <pthread.h>
#include <stdlib.h>
#include <stdint.h>
#include <time.h>
#include "common.h"

static ANativeActivity *slim_activity;
static ANativeWindow *slim_window;
static AInputQueue *slim_input_queue;
static AInputQueue *slim_attached_queue;
static AInputQueue *slim_queue_in_flight;
static ALooper *slim_game_looper;
static pthread_mutex_t slim_state_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t slim_queue_condition = PTHREAD_COND_INITIALIZER;
static pthread_t slim_game_thread;
static int slim_thread_created;
static int slim_destroying;
static int slim_resumed;
static int slim_focused;
static int slim_raw_keys[5];
static int slim_touch_keys[4];
static int slim_pending_directions[4];
static int slim_touch_action;
static int slim_pointer_held;
static float slim_pointer_x;
static float slim_pointer_y;
static int slim_pending_pressed;
static int slim_pending_restart;
static int slim_pending_menu;
static float slim_input_values[11];

#if SLIM_HAS_SOUND
static AAudioStream *slim_audio_stream;
#endif

static int slim_android_resize_framebuffer(int width, int height) {
  slim_u32 *pixels;
  size_t bytes;
  if (!slim_framebuffer_size_valid(width, height)) return 0;
  if (width == slim_fb_width && height == slim_fb_height && slim_framebuffer) return 1;
  bytes = (size_t)width * (size_t)height * sizeof(slim_u32);
  pixels = (slim_u32 *)realloc(slim_framebuffer, bytes);
  if (!pixels) return 0;
  slim_bind_framebuffer(pixels, width, height, width);
  return 1;
}

static int slim_android_prepare_framebuffer(ANativeWindow *window) {
  int width, height, left, top, view_width, view_height;
  if (!window) return 0;
  width = ANativeWindow_getWidth(window);
  height = ANativeWindow_getHeight(window);
  slim_fit_viewport(width, height, &left, &top, &view_width, &view_height);
  return slim_android_resize_framebuffer(view_width, view_height);
}

float slim_input(float index) {
  int i;
  if (!slim_is_finite(index) || index <= -1.0f || index >= 11.0f) return 0.0f;
  i = (int)index;
  return slim_input_values[i];
}

void slim_trap(void) {
  if (slim_activity) ANativeActivity_finish(slim_activity);
  __builtin_trap();
}

static void slim_clear_raw_input_locked(void) {
  int i;
  for (i = 0; i < 5; ++i) slim_raw_keys[i] = 0;
  for (i = 0; i < 4; ++i) slim_touch_keys[i] = 0;
  for (i = 0; i < 4; ++i) slim_pending_directions[i] = 0;
  slim_touch_action = 0;
  slim_pointer_held = 0;
  slim_pending_pressed = 0;
  slim_pending_restart = 0;
  slim_pending_menu = 0;
}

static int64_t slim_now_ns(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (int64_t)now.tv_sec * 1000000000ll + (int64_t)now.tv_nsec;
}

static int slim_android_key_index(int key) {
  if (key == AKEYCODE_DPAD_LEFT || key == AKEYCODE_A) return 0;
  if (key == AKEYCODE_DPAD_RIGHT || key == AKEYCODE_D) return 1;
  if (key == AKEYCODE_DPAD_UP || key == AKEYCODE_W) return 2;
  if (key == AKEYCODE_DPAD_DOWN || key == AKEYCODE_S) return 3;
  if (key == AKEYCODE_SPACE || key == AKEYCODE_ENTER || key == AKEYCODE_DPAD_CENTER ||
      key == AKEYCODE_BUTTON_A) return 4;
  return -1;
}

static int slim_update_key(AInputEvent *event) {
  int action = AKeyEvent_getAction(event);
  int key = AKeyEvent_getKeyCode(event);
  int repeat = AKeyEvent_getRepeatCount(event);
  int index = slim_android_key_index(key);
  int down = action == AKEY_EVENT_ACTION_DOWN;
  int handled = index >= 0 || key == AKEYCODE_R || key == AKEYCODE_M ||
                key == AKEYCODE_ESCAPE || key == AKEYCODE_BACK;
  pthread_mutex_lock(&slim_state_mutex);
  if (index >= 0) {
    if (down && repeat == 0 && index < 4 && !slim_raw_keys[index]) slim_pending_directions[index] = 1;
    slim_raw_keys[index] = down;
    if (down && index == 4 && repeat == 0) slim_pending_pressed = 1;
  }
  if (down && repeat == 0 && key == AKEYCODE_R) slim_pending_restart = 1;
  if (down && repeat == 0 && (key == AKEYCODE_ESCAPE || key == AKEYCODE_M || key == AKEYCODE_BACK)) slim_pending_menu = 1;
  pthread_mutex_unlock(&slim_state_mutex);
  return handled;
}

static void slim_logical_point(float screen_x, float screen_y, int width, int height,
                               float *x, float *y) {
  float sx, sy, left, top;
  if (width <= 0 || height <= 0) { *x = 0.0f; *y = 0.0f; return; }
  sx = (float)width / 800.0f;
  sy = (float)height / 600.0f;
  if (sy < sx) sx = sy;
  else sy = sx;
  left = ((float)width - 800.0f * sx) * 0.5f;
  top = ((float)height - 600.0f * sy) * 0.5f;
  *x = (screen_x - left) / sx;
  *y = (screen_y - top) / sy;
  if (*x < 0.0f) *x = 0.0f;
  if (*x > 800.0f) *x = 800.0f;
  if (*y < 0.0f) *y = 0.0f;
  if (*y > 600.0f) *y = 600.0f;
}

static int slim_touch_control(float x, float y, int keys[4], int *action,
                              int *restart, int *menu) {
  if (x >= 15.0f && x <= 82.0f && y >= 14.0f && y <= 78.0f) {
    *restart = 1;
    return 1;
  }
  if (x >= 718.0f && x <= 785.0f && y >= 14.0f && y <= 78.0f) {
    *menu = 1;
    return 1;
  }
  if (x >= 30.0f && x <= 100.0f && y >= 475.0f && y <= 545.0f) {
    keys[0] = 1;
    return 1;
  }
  if (x >= 105.0f && x <= 175.0f && y >= 420.0f && y <= 490.0f) {
    keys[2] = 1;
    return 1;
  }
  if (x >= 180.0f && x <= 250.0f && y >= 475.0f && y <= 545.0f) {
    keys[1] = 1;
    return 1;
  }
  if (x >= 105.0f && x <= 175.0f && y >= 530.0f && y <= 600.0f) {
    keys[3] = 1;
    return 1;
  }
  if (x >= 650.0f && x <= 790.0f && y >= 430.0f && y <= 580.0f) {
    *action = 1;
    return 1;
  }
  return 0;
}

static void slim_update_motion(AInputEvent *event) {
  int action_full = AMotionEvent_getAction(event);
  int action = action_full & AMOTION_EVENT_ACTION_MASK;
  int action_index = (action_full & AMOTION_EVENT_ACTION_POINTER_INDEX_MASK) >> AMOTION_EVENT_ACTION_POINTER_INDEX_SHIFT;
  int pointer_count = AMotionEvent_getPointerCount(event);
  ANativeWindow *window;
  int width, height;
  int keys[4] = {0, 0, 0, 0};
  int previous_keys[4];
  int virtual_action = 0;
  int virtual_restart = 0;
  int virtual_menu = 0;
  int pointer = 0;
  float pointer_x;
  float pointer_y;
  int new_down = action == AMOTION_EVENT_ACTION_DOWN || action == AMOTION_EVENT_ACTION_POINTER_DOWN;
  int cancel = action == AMOTION_EVENT_ACTION_CANCEL;
  int i;
  pthread_mutex_lock(&slim_state_mutex);
  for (i = 0; i < 4; ++i) previous_keys[i] = slim_touch_keys[i];
  window = slim_window;
  if (window) ANativeWindow_acquire(window);
  pthread_mutex_unlock(&slim_state_mutex);
  width = window ? ANativeWindow_getWidth(window) : 800;
  height = window ? ANativeWindow_getHeight(window) : 600;
  if (window) ANativeWindow_release(window);
  if (cancel) pointer_count = 0;
  pthread_mutex_lock(&slim_state_mutex);
  pointer_x = slim_pointer_x;
  pointer_y = slim_pointer_y;
  for (i = 0; i < pointer_count; ++i) {
    float logical_x, logical_y;
    int is_removed = (action == AMOTION_EVENT_ACTION_UP || action == AMOTION_EVENT_ACTION_POINTER_UP) && i == action_index;
    if (is_removed) continue;
    slim_logical_point(AMotionEvent_getX(event, i), AMotionEvent_getY(event, i), width, height,
                       &logical_x, &logical_y);
    if (slim_touch_control(logical_x, logical_y, keys, &virtual_action,
                           &virtual_restart, &virtual_menu)) {
      if (new_down && i == action_index) {
        if (virtual_action) slim_pending_pressed = 1;
        if (virtual_restart) slim_pending_restart = 1;
        if (virtual_menu) slim_pending_menu = 1;
      }
    } else if (!pointer) {
      pointer = 1;
      pointer_x = logical_x;
      pointer_y = logical_y;
      if (new_down && i == action_index) slim_pending_pressed = 1;
    }
  }
  for (i = 0; i < 4; ++i) {
    if (keys[i] && !previous_keys[i]) slim_pending_directions[i] = 1;
    slim_touch_keys[i] = keys[i];
  }
  slim_touch_action = virtual_action;
  slim_pointer_held = pointer;
  slim_pointer_x = pointer_x;
  slim_pointer_y = pointer_y;
  pthread_mutex_unlock(&slim_state_mutex);
}

static int32_t slim_process_input_event(AInputEvent *event) {
  int type = AInputEvent_getType(event);
  if (type == AINPUT_EVENT_TYPE_KEY) {
    return slim_update_key(event);
  }
  if (type == AINPUT_EVENT_TYPE_MOTION) {
    slim_update_motion(event);
    return 1;
  }
  return 0;
}

static void slim_android_blend_rect(float x, float y, float width, float height,
                                    slim_u32 color, float alpha) {
  int x0 = (int)(x * ((float)slim_fb_width / 800.0f));
  int y0 = (int)(y * ((float)slim_fb_height / 600.0f));
  int x1 = (int)((x + width) * ((float)slim_fb_width / 800.0f) + 0.999f);
  int y1 = (int)((y + height) * ((float)slim_fb_height / 600.0f) + 0.999f);
  int ix, iy;
  if (!slim_framebuffer || slim_fb_width <= 0 || slim_fb_height <= 0) return;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > slim_fb_width) x1 = slim_fb_width;
  if (y1 > slim_fb_height) y1 = slim_fb_height;
  for (iy = y0; iy < y1; ++iy) {
    slim_u32 *row = slim_framebuffer + iy * slim_fb_stride;
    for (ix = x0; ix < x1; ++ix) {
      slim_u32 old = row[ix];
      int r = (int)((float)((old >> 16) & 255u) * (1.0f - alpha) + (float)((color >> 16) & 255u) * alpha);
      int g = (int)((float)((old >> 8) & 255u) * (1.0f - alpha) + (float)((color >> 8) & 255u) * alpha);
      int b = (int)((float)(old & 255u) * (1.0f - alpha) + (float)(color & 255u) * alpha);
      row[ix] = ((slim_u32)r << 16) | ((slim_u32)g << 8) | (slim_u32)b;
    }
  }
}

static void slim_android_draw_letter(float x, float y, char letter) {
  static const unsigned char glyph_r[5] = {0x7f,0x09,0x19,0x29,0x46};
  static const unsigned char glyph_m[5] = {0x7f,0x02,0x04,0x02,0x7f};
  const unsigned char *glyph = letter == 'R' ? glyph_r : glyph_m;
  int col, row;
  for (col = 0; col < 5; ++col) {
    for (row = 0; row < 7; ++row) {
      if (glyph[col] & (1u << row)) {
        slim_rect(x + (float)col * 5.0f, y + (float)row * 5.0f,
                  4.0f, 4.0f, 0x00e8edf8u);
      }
    }
  }
}

static void slim_android_draw_controls(void) {
  slim_u32 panel = 0x003b4561u;
  slim_android_blend_rect(15, 14, 67, 64, panel, 0.56f);
  slim_android_blend_rect(718, 14, 67, 64, panel, 0.56f);
  slim_android_blend_rect(30, 475, 70, 70, panel, 0.56f);
  slim_android_blend_rect(105, 420, 70, 70, panel, 0.56f);
  slim_android_blend_rect(180, 475, 70, 70, panel, 0.56f);
  slim_android_blend_rect(105, 530, 70, 70, panel, 0.56f);
  slim_android_blend_rect(650, 430, 140, 150, 0x005e4d35u, 0.54f);
  slim_android_draw_letter(37, 28, 'R');
  slim_android_draw_letter(740, 28, 'M');
  slim_tri(45, 510, 82, 488, 82, 532, 0.91f, 0.94f, 1.0f);
  slim_tri(158, 450, 122, 470, 194, 470, 0.91f, 0.94f, 1.0f);
  slim_tri(235, 510, 198, 488, 198, 532, 0.91f, 0.94f, 1.0f);
  slim_tri(158, 589, 122, 552, 194, 552, 0.91f, 0.94f, 1.0f);
  slim_tri(720, 463, 685, 548, 710, 548, 0.91f, 0.94f, 1.0f);
  slim_tri(720, 463, 710, 548, 745, 548, 0.91f, 0.94f, 1.0f);
  slim_tri(704, 528, 736, 528, 738, 536, 0.12f, 0.10f, 0.08f);
}

static void slim_android_present(ANativeWindow *window) {
  ANativeWindow_Buffer buffer;
  int width, height, dest_width, dest_height, left, top, x, y;
  if (!window || ANativeWindow_lock(window, &buffer, 0) != 0) return;
  width = buffer.width;
  height = buffer.height;
  slim_fit_viewport(width, height, &left, &top, &dest_width, &dest_height);
  if (!slim_framebuffer || slim_fb_width != dest_width || slim_fb_height != dest_height ||
      !slim_framebuffer_size_valid(dest_width, dest_height)) {
    for (y = 0; y < height; ++y) {
      uint32_t *dest = (uint32_t *)buffer.bits + y * buffer.stride;
      for (x = 0; x < width; ++x) dest[x] = 0xff000000u;
    }
    ANativeWindow_unlockAndPost(window);
    return;
  }
  for (y = 0; y < height; ++y) {
    uint32_t *dest = (uint32_t *)buffer.bits + y * buffer.stride;
    for (x = 0; x < width; ++x) {
      if (x >= left && x < left + dest_width && y >= top && y < top + dest_height) {
        slim_u32 source = slim_framebuffer[(y - top) * slim_fb_stride + (x - left)];
        slim_u32 red = (source >> 16) & 255u;
        slim_u32 green = (source >> 8) & 255u;
        slim_u32 blue = source & 255u;
        dest[x] = 0xff000000u | (blue << 16) | (green << 8) | red;
      } else {
        dest[x] = 0xff000000u;
      }
    }
  }
  ANativeWindow_unlockAndPost(window);
}

static void slim_snapshot_inputs_locked(void) {
  int i;
  for (i = 0; i < 4; ++i) {
    slim_input_values[i] = (float)(slim_raw_keys[i] || slim_touch_keys[i] || slim_pending_directions[i]);
    slim_pending_directions[i] = 0;
  }
  slim_input_values[4] = (float)(slim_raw_keys[4] || slim_touch_action || slim_pointer_held);
  slim_input_values[5] = (float)slim_pending_pressed;
  slim_input_values[6] = slim_pointer_x;
  slim_input_values[7] = slim_pointer_y;
  slim_input_values[8] = (float)slim_pointer_held;
  slim_input_values[9] = (float)slim_pending_restart;
  slim_input_values[10] = (float)slim_pending_menu;
  slim_pending_pressed = 0;
  slim_pending_restart = 0;
  slim_pending_menu = 0;
}

static void slim_poll_input(ALooper *looper, AInputQueue *queue, int timeout_ms) {
  int events = 0;
  void *data = 0;
  int ident = ALooper_pollOnce(timeout_ms, 0, &events, &data);
  if (ident == 1 && queue) {
    AInputEvent *event;
    while (AInputQueue_getEvent(queue, &event) >= 0) {
      if (AInputQueue_preDispatchEvent(queue, event)) continue;
      AInputQueue_finishEvent(queue, event, slim_process_input_event(event));
    }
  }
  (void)looper;
  (void)events;
  (void)data;
}

static void *slim_game_loop(void *unused) {
  int64_t next_frame = slim_now_ns();
  ALooper *looper;
  AInputQueue *attached_queue = 0;
  (void)unused;
  looper = ALooper_prepare(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS);
  pthread_mutex_lock(&slim_state_mutex);
  slim_game_looper = looper;
  pthread_mutex_unlock(&slim_state_mutex);
  slim_init();
  for (;;) {
    ANativeWindow *window;
    AInputQueue *requested_queue;
    int running;
    int64_t now = slim_now_ns();
    pthread_mutex_lock(&slim_state_mutex);
    running = !slim_destroying;
    requested_queue = slim_input_queue;
    if (requested_queue != attached_queue) slim_queue_in_flight = requested_queue;
    window = slim_window;
    if (running && slim_resumed && slim_focused && window) {
      ANativeWindow_acquire(window);
    } else window = 0;
    pthread_mutex_unlock(&slim_state_mutex);
    if (requested_queue != attached_queue) {
      if (attached_queue) AInputQueue_detachLooper(attached_queue);
      attached_queue = requested_queue;
      if (attached_queue) AInputQueue_attachLooper(attached_queue, looper, 1, 0, 0);
      pthread_mutex_lock(&slim_state_mutex);
      slim_attached_queue = attached_queue;
      slim_queue_in_flight = 0;
      pthread_cond_broadcast(&slim_queue_condition);
      pthread_mutex_unlock(&slim_state_mutex);
    }
    if (!running) {
      if (window) ANativeWindow_release(window);
      break;
    }
    /* Keep Android's input queue responsive even when frames overrun the
       pacing deadline and the render loop has no idle wait to poll in. */
    slim_poll_input(looper, attached_queue, 0);
    if (!window) {
      next_frame = now + 16666667ll;
      slim_poll_input(looper, attached_queue, 10);
      continue;
    }
    if (!slim_android_prepare_framebuffer(window)) {
      ANativeWindow_release(window);
      slim_poll_input(looper, attached_queue, 8);
      continue;
    }
    if (now < next_frame) {
      ANativeWindow_release(window);
      int timeout = (int)((next_frame - now) / 1000000ll);
      if (timeout > 8) timeout = 8;
      if (timeout < 0) timeout = 0;
      slim_poll_input(looper, attached_queue, timeout);
      continue;
    }
    next_frame += 16666667ll;
    if (now - next_frame > 100000000ll) next_frame = now + 16666667ll;
    pthread_mutex_lock(&slim_state_mutex);
    slim_snapshot_inputs_locked();
    pthread_mutex_unlock(&slim_state_mutex);
    slim_clear();
    slim_frame();
    slim_android_draw_controls();
    slim_android_present(window);
    ANativeWindow_release(window);
    slim_input_values[5] = 0.0f;
    slim_input_values[9] = 0.0f;
    slim_input_values[10] = 0.0f;
  }
  if (attached_queue) AInputQueue_detachLooper(attached_queue);
  free(slim_framebuffer);
  slim_bind_framebuffer(0, 0, 0, 0);
  pthread_mutex_lock(&slim_state_mutex);
  slim_attached_queue = 0;
  slim_queue_in_flight = 0;
  slim_game_looper = 0;
  pthread_cond_broadcast(&slim_queue_condition);
  pthread_mutex_unlock(&slim_state_mutex);
  return 0;
}

static void slim_set_window(ANativeWindow *window) {
  pthread_mutex_lock(&slim_state_mutex);
  if (window) ANativeWindow_acquire(window);
  if (slim_window) ANativeWindow_release(slim_window);
  slim_window = window;
  pthread_mutex_unlock(&slim_state_mutex);
}

static void slim_on_window_created(ANativeActivity *activity, ANativeWindow *window) {
  (void)activity;
  ANativeWindow_setBuffersGeometry(window, 0, 0, WINDOW_FORMAT_RGBA_8888);
  slim_set_window(window);
}

static void slim_on_window_destroyed(ANativeActivity *activity, ANativeWindow *window) {
  (void)activity;
  pthread_mutex_lock(&slim_state_mutex);
  if (slim_window == window) {
    ANativeWindow_release(slim_window);
    slim_window = 0;
    slim_clear_raw_input_locked();
  }
  pthread_mutex_unlock(&slim_state_mutex);
}

#if SLIM_HAS_SOUND
static void slim_audio_start(void);
#endif

static void slim_on_resume(ANativeActivity *activity) {
  (void)activity;
  pthread_mutex_lock(&slim_state_mutex);
  slim_resumed = 1;
  pthread_mutex_unlock(&slim_state_mutex);
#if SLIM_HAS_SOUND
  if (slim_audio_stream) AAudioStream_requestStart(slim_audio_stream);
  else slim_audio_start();
#endif
}

static void slim_on_pause(ANativeActivity *activity) {
  (void)activity;
  pthread_mutex_lock(&slim_state_mutex);
  slim_resumed = 0;
  slim_clear_raw_input_locked();
  pthread_mutex_unlock(&slim_state_mutex);
#if SLIM_HAS_SOUND
  if (slim_audio_stream) AAudioStream_requestPause(slim_audio_stream);
#endif
}

static void slim_on_focus_changed(ANativeActivity *activity, int focused) {
  (void)activity;
  pthread_mutex_lock(&slim_state_mutex);
  slim_focused = focused;
  if (!focused) slim_clear_raw_input_locked();
  pthread_mutex_unlock(&slim_state_mutex);
}

#if SLIM_HAS_SOUND
static aaudio_data_callback_result_t slim_audio_callback(AAudioStream *stream, void *user,
                                                          void *data, int32_t frames) {
  int rate = AAudioStream_getSampleRate(stream);
  (void)user;
  if (rate <= 0) rate = SLIM_AUDIO_RATE;
  slim_mix_audio((float *)data, frames, rate);
  return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

static void slim_audio_start(void) {
  AAudioStreamBuilder *builder = 0;
  if (slim_audio_stream) return;
  if (AAudio_createStreamBuilder(&builder) != AAUDIO_OK) return;
  AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
  AAudioStreamBuilder_setSampleRate(builder, SLIM_AUDIO_RATE);
  AAudioStreamBuilder_setChannelCount(builder, 1);
  AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_FLOAT);
  AAudioStreamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
  AAudioStreamBuilder_setDataCallback(builder, slim_audio_callback, 0);
  if (AAudioStreamBuilder_openStream(builder, &slim_audio_stream) != AAUDIO_OK) slim_audio_stream = 0;
  AAudioStreamBuilder_delete(builder);
  if (slim_audio_stream) AAudioStream_requestStart(slim_audio_stream);
}

static void slim_audio_stop(void) {
  if (!slim_audio_stream) return;
  AAudioStream_requestStop(slim_audio_stream);
  AAudioStream_close(slim_audio_stream);
  slim_audio_stream = 0;
}
#endif

static void slim_on_destroy(ANativeActivity *activity) {
  ALooper *looper;
  (void)activity;
  pthread_mutex_lock(&slim_state_mutex);
  slim_destroying = 1;
  looper = slim_game_looper;
  slim_clear_raw_input_locked();
  pthread_mutex_unlock(&slim_state_mutex);
  if (looper) ALooper_wake(looper);
  if (slim_thread_created) pthread_join(slim_game_thread, 0);
#if SLIM_HAS_SOUND
  slim_audio_stop();
#endif
  pthread_mutex_lock(&slim_state_mutex);
  if (slim_window) ANativeWindow_release(slim_window);
  slim_window = 0;
  pthread_mutex_unlock(&slim_state_mutex);
}

static void slim_on_input_queue_created(ANativeActivity *activity, AInputQueue *queue) {
  ALooper *looper;
  (void)activity;
  pthread_mutex_lock(&slim_state_mutex);
  slim_input_queue = queue;
  looper = slim_game_looper;
  pthread_mutex_unlock(&slim_state_mutex);
  if (looper) ALooper_wake(looper);
}

static void slim_on_input_queue_destroyed(ANativeActivity *activity, AInputQueue *queue) {
  ALooper *looper;
  (void)activity;
  pthread_mutex_lock(&slim_state_mutex);
  if (slim_input_queue == queue) slim_input_queue = 0;
  looper = slim_game_looper;
  pthread_mutex_unlock(&slim_state_mutex);
  if (looper) ALooper_wake(looper);
  pthread_mutex_lock(&slim_state_mutex);
  while (slim_attached_queue == queue || slim_queue_in_flight == queue) {
    pthread_cond_wait(&slim_queue_condition, &slim_state_mutex);
  }
  pthread_mutex_unlock(&slim_state_mutex);
}

__attribute__((visibility("default")))
void ANativeActivity_onCreate(ANativeActivity *activity, void *saved_state, size_t saved_state_size) {
  (void)saved_state;
  (void)saved_state_size;
  pthread_mutex_lock(&slim_state_mutex);
  slim_destroying = 0;
  slim_resumed = 0;
  slim_focused = 0;
  slim_window = 0;
  slim_input_queue = 0;
  slim_attached_queue = 0;
  slim_queue_in_flight = 0;
  slim_game_looper = 0;
  slim_thread_created = 0;
  slim_clear_raw_input_locked();
  slim_pointer_x = 0.0f;
  slim_pointer_y = 0.0f;
  slim_input_values[0] = slim_input_values[1] = slim_input_values[2] = slim_input_values[3] = 0.0f;
  slim_input_values[4] = slim_input_values[5] = slim_input_values[6] = slim_input_values[7] = 0.0f;
  slim_input_values[8] = slim_input_values[9] = slim_input_values[10] = 0.0f;
  pthread_mutex_unlock(&slim_state_mutex);
  slim_activity = activity;
  activity->callbacks->onResume = slim_on_resume;
  activity->callbacks->onPause = slim_on_pause;
  activity->callbacks->onDestroy = slim_on_destroy;
  activity->callbacks->onWindowFocusChanged = slim_on_focus_changed;
  activity->callbacks->onNativeWindowCreated = slim_on_window_created;
  activity->callbacks->onNativeWindowDestroyed = slim_on_window_destroyed;
  activity->callbacks->onInputQueueCreated = slim_on_input_queue_created;
  activity->callbacks->onInputQueueDestroyed = slim_on_input_queue_destroyed;
  if (pthread_create(&slim_game_thread, 0, slim_game_loop, 0) == 0) {
    slim_thread_created = 1;
  } else {
    ANativeActivity_finish(activity);
  }
}
