#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <stdint.h>
#define SLIM_SYSTEM_TEXT 1
#include "common.h"

static HWND slim_window;
static int slim_running;
static int slim_keys[5];
static int slim_pending_directions[4];
static int slim_pointer_held;
static int slim_pressed;
static int slim_restart_pressed;
static int slim_menu_pressed;
static float slim_pointer_x;
static float slim_pointer_y;
static HDC slim_surface_dc;
static HBITMAP slim_surface_bitmap;
static HBITMAP slim_surface_previous;
static slim_u32 *slim_surface_pixels;
static int slim_surface_width;
static int slim_surface_height;

static void slim_zero_pixels(slim_u32 *pixels, SIZE_T count) {
  SIZE_T i;
  for (i = 0; i < count; ++i) pixels[i] = 0;
}
#if SLIM_HAS_TEXT
#define SLIM_TEXT_COMMANDS 64
typedef struct SlimTextCommand {
  uint32_t id;
  float x, y, size;
  int tone;
} SlimTextCommand;
static SlimTextCommand slim_text_commands[SLIM_TEXT_COMMANDS];
static uint32_t slim_text_command_count;

float slim_text(float id_value, float x, float y, float size, float tone) {
  uint32_t id;
  SlimTextCommand *command;
  int tone_index;
  if (!slim_is_finite(id_value) || !slim_is_finite(x) || !slim_is_finite(y) ||
      !slim_is_finite(size) || !slim_is_finite(tone) || size <= 0.0f || size > 4096.0f ||
      x < -100000.0f || x > 100000.0f || y < -100000.0f || y > 100000.0f ||
      id_value < 0.0f || id_value >= (float)slim_text_count || id_value >= 2147483520.0f ||
      slim_text_command_count >= SLIM_TEXT_COMMANDS) return 0.0f;
  id = (uint32_t)id_value;
  if (id >= slim_text_count) return 0.0f;
  tone_index = tone >= 0.0f && tone < 4.0f ? (int)tone : 0;
  command = slim_text_commands + slim_text_command_count++;
  command->id = id;
  command->x = x;
  command->y = y;
  command->size = size;
  command->tone = tone_index;
  return 0.0f;
}

static void slim_draw_text(HDC dc, int left, int top, int width, int height) {
  static const COLORREF tones[4] = {RGB(255,255,255), RGB(244,192,74), RGB(126,232,162), RGB(141,154,192)};
  static const int outline_offsets[8][2] = {
    {-1,0}, {1,0}, {0,-1}, {0,1}, {-1,-1}, {-1,1}, {1,-1}, {1,1}
  };
  uint32_t i;
  int old_background, old_alignment;
  COLORREF old_color;
  HFONT font = 0;
  HGDIOBJ original_font = 0;
  int font_pixels = -1;
  old_background = SetBkMode(dc, TRANSPARENT);
  old_alignment = SetTextAlign(dc, TA_CENTER | TA_BASELINE);
  old_color = SetTextColor(dc, RGB(8,10,22));
  for (i = 0; i < slim_text_command_count; ++i) {
    SlimTextCommand *command = slim_text_commands + i;
    const char *text = slim_texts[command->id];
    wchar_t wide_text[512];
    int wide_count, pixel_size, outline, px, py, offset;
    float scaled_size;
    if (!text) continue;
    scaled_size = command->size * (float)height / 600.0f;
    if (!slim_is_finite(scaled_size) || scaled_size <= 0.0f || scaled_size > 4096.0f) continue;
    pixel_size = (int)(scaled_size + 0.5f);
    if (pixel_size < 1) pixel_size = 1;
    if (pixel_size != font_pixels) {
      HFONT next_font;
      if (font) {
        SelectObject(dc, original_font);
        DeleteObject(font);
        font = 0;
        original_font = 0;
      }
      next_font = CreateFontW(-pixel_size, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                              DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                              ANTIALIASED_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
      if (next_font) {
        font = next_font;
        original_font = SelectObject(dc, font);
        font_pixels = pixel_size;
      } else font_pixels = -1;
    }
    if (!font) continue;
    wide_count = MultiByteToWideChar(CP_UTF8, 0, text, -1, wide_text,
                                     (int)(sizeof(wide_text) / sizeof(wide_text[0])));
    if (wide_count <= 1) continue;
    px = left + (int)(command->x * (float)width / 800.0f);
    py = top + (int)(command->y * (float)height / 600.0f);
    outline = pixel_size / 10;
    if (outline < 1) outline = 1;
    SetTextColor(dc, RGB(8,10,22));
    for (offset = 0; offset < 8; ++offset) {
      TextOutW(dc, px + outline_offsets[offset][0] * outline,
               py + outline_offsets[offset][1] * outline, wide_text, wide_count - 1);
    }
    SetTextColor(dc, tones[command->tone]);
    TextOutW(dc, px, py, wide_text, wide_count - 1);
  }
  if (font) {
    SelectObject(dc, original_font);
    DeleteObject(font);
  }
  SetTextColor(dc, old_color);
  SetTextAlign(dc, old_alignment);
  SetBkMode(dc, old_background);
}
#endif

static int slim_resize_framebuffer(HWND window) {
  RECT client;
  BITMAPINFO info;
  HDC next_dc;
  HBITMAP next_bitmap, next_previous;
  slim_u32 *next_pixels = 0;
  int client_width, client_height, left, top, width, height;
  if (!window || !GetClientRect(window, &client)) return 0;
  client_width = client.right - client.left;
  client_height = client.bottom - client.top;
  slim_fit_viewport(client_width, client_height, &left, &top, &width, &height);
  if (!slim_framebuffer_size_valid(client_width, client_height) ||
      !slim_framebuffer_size_valid(width, height)) return 0;
  if (slim_surface_dc && slim_surface_width == client_width &&
      slim_surface_height == client_height && slim_fb_width == width &&
      slim_fb_height == height) return 1;
  next_dc = CreateCompatibleDC(0);
  if (!next_dc) return 0;
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = client_width;
  info.bmiHeader.biHeight = -client_height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  info.bmiHeader.biSizeImage = 0;
  info.bmiHeader.biXPelsPerMeter = 0;
  info.bmiHeader.biYPelsPerMeter = 0;
  info.bmiHeader.biClrUsed = 0;
  info.bmiHeader.biClrImportant = 0;
  info.bmiColors[0].rgbBlue = 0;
  info.bmiColors[0].rgbGreen = 0;
  info.bmiColors[0].rgbRed = 0;
  info.bmiColors[0].rgbReserved = 0;
  next_bitmap = CreateDIBSection(next_dc, &info, DIB_RGB_COLORS,
                                 (void **)&next_pixels, 0, 0);
  if (!next_bitmap || !next_pixels) {
    if (next_bitmap) DeleteObject(next_bitmap);
    DeleteDC(next_dc);
    return 0;
  }
  next_previous = (HBITMAP)SelectObject(next_dc, next_bitmap);
  if (!next_previous || next_previous == (HBITMAP)HGDI_ERROR) {
    DeleteObject(next_bitmap);
    DeleteDC(next_dc);
    return 0;
  }
  slim_zero_pixels(next_pixels, (SIZE_T)client_width * (SIZE_T)client_height);
  if (slim_surface_dc) {
    GdiFlush();
    StretchBlt(next_dc, 0, 0, client_width, client_height,
               slim_surface_dc, 0, 0, slim_surface_width, slim_surface_height, SRCCOPY);
    SelectObject(slim_surface_dc, slim_surface_previous);
    DeleteObject(slim_surface_bitmap);
    DeleteDC(slim_surface_dc);
  }
  slim_surface_dc = next_dc;
  slim_surface_bitmap = next_bitmap;
  slim_surface_previous = next_previous;
  slim_surface_pixels = next_pixels;
  slim_surface_width = client_width;
  slim_surface_height = client_height;
  slim_bind_framebuffer(next_pixels + top * client_width + left,
                        width, height, client_width);
  return 1;
}

static int slim_prepare_framebuffer(HWND window) {
  return slim_resize_framebuffer(window);
}
#if SLIM_HAS_SOUND
#define SLIM_WAVE_BLOCKS 4
#define SLIM_WAVE_SAMPLES 256
static HWAVEOUT slim_waveout;
static WAVEHDR slim_wave_headers[SLIM_WAVE_BLOCKS];
static short slim_wave_data[SLIM_WAVE_BLOCKS][SLIM_WAVE_SAMPLES];
static float slim_wave_mix[SLIM_WAVE_BLOCKS][SLIM_WAVE_SAMPLES];
static int slim_audio_stopping;
static void slim_wave_complete(WAVEHDR *header);
#endif

float slim_input(float index) {
  if (!slim_is_finite(index) || index <= -1.0f || index >= 11.0f) return 0.0f;
  switch ((int)index) {
    case 0: return (float)(slim_keys[0] || slim_pending_directions[0]);
    case 1: return (float)(slim_keys[1] || slim_pending_directions[1]);
    case 2: return (float)(slim_keys[2] || slim_pending_directions[2]);
    case 3: return (float)(slim_keys[3] || slim_pending_directions[3]);
    case 4: return (float)(slim_keys[4] || slim_pointer_held);
    case 5: return (float)slim_pressed;
    case 6: return slim_pointer_x;
    case 7: return slim_pointer_y;
    case 8: return (float)slim_pointer_held;
    case 9: return (float)slim_restart_pressed;
    case 10: return (float)slim_menu_pressed;
    default: return 0.0f;
  }
}

void slim_trap(void) {
  ExitProcess(1);
  for (;;) { }
}

static void slim_clear_input(void) {
  int i;
  for (i = 0; i < 5; ++i) slim_keys[i] = 0;
  for (i = 0; i < 4; ++i) slim_pending_directions[i] = 0;
  slim_pointer_held = 0;
  slim_pressed = 0;
  slim_restart_pressed = 0;
  slim_menu_pressed = 0;
}

static void slim_update_pointer(int x, int y) {
  RECT rect;
  int width, height, left, top, view_width, view_height;
  if (!slim_window || !GetClientRect(slim_window, &rect)) return;
  width = rect.right - rect.left;
  height = rect.bottom - rect.top;
  if (width < 1 || height < 1) return;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x > width) x = width;
  if (y > height) y = height;
  slim_fit_viewport(width, height, &left, &top, &view_width, &view_height);
  if (view_width < 1 || view_height < 1) return;
  slim_pointer_x = (float)(x - left) * (800.0f / (float)view_width);
  slim_pointer_y = (float)(y - top) * (600.0f / (float)view_height);
  if (slim_pointer_x < 0.0f) slim_pointer_x = 0.0f;
  if (slim_pointer_y < 0.0f) slim_pointer_y = 0.0f;
  if (slim_pointer_x > 800.0f) slim_pointer_x = 800.0f;
  if (slim_pointer_y > 600.0f) slim_pointer_y = 600.0f;
}

static int slim_key_index(WPARAM key) {
  if (key == VK_LEFT || key == 'A') return 0;
  if (key == VK_RIGHT || key == 'D') return 1;
  if (key == VK_UP || key == 'W') return 2;
  if (key == VK_DOWN || key == 'S') return 3;
  if (key == VK_SPACE || key == VK_RETURN) return 4;
  return -1;
}

static void slim_key_event(WPARAM key, LPARAM details, int down) {
  int index = slim_key_index(key);
  int repeat = (details & (1L << 30)) != 0;
  if (index >= 0) {
    slim_keys[index] = down;
    if (down && index == 4 && !repeat) slim_pressed = 1;
    if (down && index < 4 && !repeat) slim_pending_directions[index] = 1;
  }
  if (down && !repeat && key == 'R') slim_restart_pressed = 1;
  if (down && !repeat && (key == VK_ESCAPE || key == 'M')) slim_menu_pressed = 1;
}

static void slim_blit_surface(HDC dc) {
  RECT rect;
  if (!slim_window || !GetClientRect(slim_window, &rect)) return;
  if (slim_surface_dc && slim_surface_width == rect.right - rect.left &&
      slim_surface_height == rect.bottom - rect.top) {
    BitBlt(dc, 0, 0, slim_surface_width, slim_surface_height,
           slim_surface_dc, 0, 0, SRCCOPY);
  } else {
    PatBlt(dc, 0, 0, rect.right - rect.left, rect.bottom - rect.top, BLACKNESS);
  }
}

static void slim_present(void) {
  HDC dc;
  if (!slim_window) return;
  dc = GetDC(slim_window);
  if (!dc) return;
  slim_blit_surface(dc);
  ReleaseDC(slim_window, dc);
}

#if SLIM_HAS_TEXT
static void slim_compose_text(void) {
  int left, top, width, height;
  if (!slim_surface_dc) return;
  slim_fit_viewport(slim_surface_width, slim_surface_height,
                    &left, &top, &width, &height);
  if (width == slim_fb_width && height == slim_fb_height) {
    slim_draw_text(slim_surface_dc, left, top, width, height);
  }
}
#endif

static LRESULT CALLBACK slim_window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_CLOSE:
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      slim_running = 0;
      PostQuitMessage(0);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_SIZE:
      slim_prepare_framebuffer(window);
      return 0;
    case WM_KEYDOWN:
      slim_key_event(wparam, lparam, 1);
      return 0;
    case WM_SYSKEYDOWN:
      slim_key_event(wparam, lparam, 1);
      return DefWindowProcW(window, message, wparam, lparam);
    case WM_KEYUP:
      slim_key_event(wparam, lparam, 0);
      return 0;
    case WM_SYSKEYUP:
      slim_key_event(wparam, lparam, 0);
      return DefWindowProcW(window, message, wparam, lparam);
    case WM_LBUTTONDOWN:
      SetCapture(window);
      slim_update_pointer((short)LOWORD(lparam), (short)HIWORD(lparam));
      slim_pointer_held = 1;
      slim_pressed = 1;
      return 0;
    case WM_LBUTTONUP:
      slim_update_pointer((short)LOWORD(lparam), (short)HIWORD(lparam));
      slim_pointer_held = 0;
      if (GetCapture() == window) ReleaseCapture();
      return 0;
    case WM_MOUSEMOVE:
      slim_update_pointer((short)LOWORD(lparam), (short)HIWORD(lparam));
      return 0;
    case WM_KILLFOCUS:
      slim_clear_input();
      return 0;
    case WM_PAINT: {
      PAINTSTRUCT paint;
      HDC dc = BeginPaint(window, &paint);
      slim_blit_surface(dc);
      EndPaint(window, &paint);
      return 0;
    }
#if SLIM_HAS_SOUND
    case MM_WOM_DONE:
      if ((HWAVEOUT)wparam == slim_waveout && !slim_audio_stopping) {
        slim_wave_complete((WAVEHDR *)lparam);
        return 0;
      }
      break;
#endif
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

#if SLIM_HAS_SOUND
static void slim_fill_wave(WAVEHDR *header) {
  int index = (int)header->dwUser;
  int i;
  slim_mix_audio(slim_wave_mix[index], SLIM_WAVE_SAMPLES, SLIM_AUDIO_RATE);
  for (i = 0; i < SLIM_WAVE_SAMPLES; ++i) {
    float sample = slim_wave_mix[index][i];
    slim_wave_data[index][i] = (short)(sample * 32767.0f);
  }
}

static void slim_wave_complete(WAVEHDR *header) {
  slim_fill_wave(header);
  waveOutWrite(slim_waveout, header, sizeof(WAVEHDR));
}

static void slim_audio_start(void) {
  WAVEFORMATEX format;
  int i;
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 1;
  format.nSamplesPerSec = SLIM_AUDIO_RATE;
  format.nAvgBytesPerSec = SLIM_AUDIO_RATE * 2;
  format.nBlockAlign = 2;
  format.wBitsPerSample = 16;
  format.cbSize = 0;
  slim_audio_stopping = 0;
  if (waveOutOpen(&slim_waveout, WAVE_MAPPER, &format,
                  (DWORD_PTR)slim_window, 0, CALLBACK_WINDOW) != MMSYSERR_NOERROR) {
    slim_waveout = 0;
    return;
  }
  for (i = 0; i < SLIM_WAVE_BLOCKS; ++i) {
    WAVEHDR *header = slim_wave_headers + i;
    header->lpData = (LPSTR)slim_wave_data[i];
    header->dwBufferLength = sizeof(slim_wave_data[i]);
    header->dwBytesRecorded = 0;
    header->dwUser = (DWORD_PTR)i;
    header->dwFlags = 0;
    header->dwLoops = 0;
    header->lpNext = 0;
    header->reserved = 0;
    if (waveOutPrepareHeader(slim_waveout, header, sizeof(WAVEHDR)) == MMSYSERR_NOERROR) {
      slim_fill_wave(header);
      waveOutWrite(slim_waveout, header, sizeof(WAVEHDR));
    }
  }
}

static void slim_audio_stop(void) {
  int i;
  if (!slim_waveout) return;
  slim_audio_stopping = 1;
  waveOutReset(slim_waveout);
  for (i = 0; i < SLIM_WAVE_BLOCKS; ++i) {
    if (slim_wave_headers[i].dwFlags & WHDR_PREPARED) {
      waveOutUnprepareHeader(slim_waveout, slim_wave_headers + i, sizeof(WAVEHDR));
    }
  }
  waveOutClose(slim_waveout);
  slim_waveout = 0;
}
#endif

#if SLIM_SMOKE
#pragma pack(push, 1)
typedef struct SlimBmpFileHeader {
  uint16_t type;
  uint32_t size;
  uint16_t reserved1;
  uint16_t reserved2;
  uint32_t offset;
} SlimBmpFileHeader;
typedef struct SlimBmpInfoHeader {
  uint32_t size;
  int32_t width;
  int32_t height;
  uint16_t planes;
  uint16_t bits;
  uint32_t compression;
  uint32_t image_size;
  int32_t x_pixels_per_meter;
  int32_t y_pixels_per_meter;
  uint32_t colors_used;
  uint32_t important_colors;
} SlimBmpInfoHeader;
#pragma pack(pop)

static int slim_write_smoke_bmp(void) {
  HANDLE file;
  DWORD written;
  int y;
  uint32_t image_size;
  SlimBmpFileHeader file_header;
  SlimBmpInfoHeader info;
  file = CreateFileA("slim-smoke.bmp", GENERIC_WRITE, FILE_SHARE_READ, 0,
                     CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
  if (file == INVALID_HANDLE_VALUE) return 0;
  image_size = (uint32_t)((size_t)slim_fb_width * (size_t)slim_fb_height * sizeof(slim_u32));
  file_header.type = 0x4d42;
  file_header.size = (uint32_t)(sizeof(file_header) + sizeof(info) + image_size);
  file_header.reserved1 = 0;
  file_header.reserved2 = 0;
  file_header.offset = (uint32_t)(sizeof(file_header) + sizeof(info));
  info.size = sizeof(info);
  info.width = slim_fb_width;
  info.height = slim_fb_height;
  info.planes = 1;
  info.bits = 32;
  info.compression = BI_RGB;
  info.image_size = image_size;
  info.x_pixels_per_meter = 0;
  info.y_pixels_per_meter = 0;
  info.colors_used = 0;
  info.important_colors = 0;
  if (!WriteFile(file, &file_header, sizeof(file_header), &written, 0) || written != sizeof(file_header) ||
      !WriteFile(file, &info, sizeof(info), &written, 0) || written != sizeof(info)) {
    CloseHandle(file);
    return 0;
  }
  for (y = slim_fb_height - 1; y >= 0; --y) {
    DWORD row_size = (DWORD)((size_t)slim_fb_width * sizeof(slim_u32));
    if (!WriteFile(file, slim_framebuffer + y * slim_fb_width, row_size, &written, 0) ||
        written != row_size) {
      CloseHandle(file);
      return 0;
    }
  }
  CloseHandle(file);
  return 1;
}

static int slim_smoke_ticks(const char *command, int *is_smoke) {
  int count = 120;
  *is_smoke = 0;
  while (*command) {
    const char *start, *end;
    while (*command == ' ' || *command == '\t') ++command;
    if (!*command) break;
    if (*command == '"') {
      start = ++command;
      while (*command && *command != '"') ++command;
      end = command;
      if (*command) ++command;
    } else {
      start = command;
      while (*command && *command != ' ' && *command != '\t') ++command;
      end = command;
    }
    if (end - start == 7 && start[0] == '-' && start[1] == '-' &&
        start[2] == 's' && start[3] == 'm' && start[4] == 'o' && start[5] == 'k' && start[6] == 'e') {
      *is_smoke = 1;
    } else if (end - start >= 8 && start[0] == '-' && start[1] == '-' &&
               start[2] == 't' && start[3] == 'i' && start[4] == 'c' &&
               start[5] == 'k' && start[6] == 's' && start[7] == '=') {
      const char *n = start + 8;
      count = 0;
      while (n < end && *n >= '0' && *n <= '9') {
        int digit = *n++ - '0';
        if (count < 36000) {
          count = count * 10 + digit;
          if (count > 36000) count = 36000;
        }
      }
      *is_smoke = 1;
    }
  }
  if (count < 1) count = 1;
  if (count > 36000) count = 36000;
  return count;
}

typedef struct SlimBenchmarkResult {
  uint64_t presents;
  uint64_t ticks;
  uint64_t elapsed;
  uint64_t frequency;
  uint64_t work;
  uint32_t framebuffer_width;
  uint32_t framebuffer_height;
  uint32_t client_width;
  uint32_t client_height;
  uint32_t window_dpi;
  uint32_t dpi_awareness;
} SlimBenchmarkResult;

static int slim_benchmark_requested(void) {
  const char *command = GetCommandLineA();
  while (*command) {
    const char *start, *end;
    while (*command == ' ' || *command == '\t') ++command;
    if (!*command) break;
    if (*command == '"') {
      start = ++command;
      while (*command && *command != '"') ++command;
      end = command;
      if (*command) ++command;
    } else {
      start = command;
      while (*command && *command != ' ' && *command != '\t') ++command;
      end = command;
    }
    if (end - start != 7 || start[0] != '-' || start[1] != '-' ||
        start[2] != 'b' || start[3] != 'e' || start[4] != 'n' ||
        start[5] != 'c' || start[6] != 'h') continue;
    return 1;
  }
  return 0;
}

static int slim_large_benchmark_requested(void) {
  const char *command = GetCommandLineA();
  while (*command) {
    const char *start, *end;
    while (*command == ' ' || *command == '\t') ++command;
    if (!*command) break;
    if (*command == '"') {
      start = ++command;
      while (*command && *command != '"') ++command;
      end = command;
      if (*command) ++command;
    } else {
      start = command;
      while (*command && *command != ' ' && *command != '\t') ++command;
      end = command;
    }
    if (end - start == 7 && start[0] == '-' && start[1] == '-' && start[2] == 'l' &&
        start[3] == 'a' && start[4] == 'r' && start[5] == 'g' && start[6] == 'e') return 1;
  }
  return 0;
}

static int slim_game_benchmark_requested(void) {
  const char *command = GetCommandLineA();
  while (*command) {
    const char *start, *end;
    while (*command == ' ' || *command == '\t') ++command;
    if (!*command) break;
    if (*command == '"') {
      start = ++command;
      while (*command && *command != '"') ++command;
      end = command;
      if (*command) ++command;
    } else {
      start = command;
      while (*command && *command != ' ' && *command != '\t') ++command;
      end = command;
    }
    if (end - start == 6 && start[0] == '-' && start[1] == '-' && start[2] == 'p' &&
        start[3] == 'l' && start[4] == 'a' && start[5] == 'y') return 1;
  }
  return 0;
}

static void slim_write_benchmark(const SlimBenchmarkResult *result) {
  HANDLE file = CreateFileA("slim-benchmark.bin", GENERIC_WRITE, 0, 0,
                            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
  DWORD written;
  if (file == INVALID_HANDLE_VALUE) return;
  WriteFile(file, result, sizeof(*result), &written, 0);
  CloseHandle(file);
}

static void slim_write_offscreen_benchmark(const SlimBenchmarkResult *result) {
  HANDLE file = CreateFileA("slim-offscreen-benchmark.bin", GENERIC_WRITE, 0, 0,
                            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
  DWORD written;
  if (file == INVALID_HANDLE_VALUE) return;
  WriteFile(file, result, sizeof(*result), &written, 0);
  CloseHandle(file);
}

static int slim_write_composed_bmp(void) {
  HANDLE file;
  DWORD written;
  int y;
  uint32_t image_size;
  SlimBmpFileHeader file_header;
  SlimBmpInfoHeader info;
  if (!slim_surface_pixels || slim_surface_width < 1 || slim_surface_height < 1) return 0;
  GdiFlush();
  image_size = (uint32_t)((size_t)slim_surface_width * (size_t)slim_surface_height * sizeof(slim_u32));
  file = CreateFileA("slim-composed.bmp", GENERIC_WRITE, FILE_SHARE_READ, 0,
                     CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
  if (file == INVALID_HANDLE_VALUE) return 0;
  file_header.type = 0x4d42;
  file_header.size = (uint32_t)(sizeof(file_header) + sizeof(info) + image_size);
  file_header.reserved1 = 0;
  file_header.reserved2 = 0;
  file_header.offset = (uint32_t)(sizeof(file_header) + sizeof(info));
  info.size = sizeof(info);
  info.width = slim_surface_width;
  info.height = slim_surface_height;
  info.planes = 1;
  info.bits = 32;
  info.compression = BI_RGB;
  info.image_size = image_size;
  info.x_pixels_per_meter = 0;
  info.y_pixels_per_meter = 0;
  info.colors_used = 0;
  info.important_colors = 0;
  if (!WriteFile(file, &file_header, sizeof(file_header), &written, 0) || written != sizeof(file_header) ||
      !WriteFile(file, &info, sizeof(info), &written, 0) || written != sizeof(info)) {
    CloseHandle(file);
    return 0;
  }
  for (y = slim_surface_height - 1; y >= 0; --y) {
    DWORD row_size = (DWORD)((size_t)slim_surface_width * sizeof(slim_u32));
    if (!WriteFile(file, slim_surface_pixels + (size_t)y * (size_t)slim_surface_width,
                   row_size, &written, 0) || written != row_size) {
      CloseHandle(file);
      return 0;
    }
  }
  CloseHandle(file);
  return 1;
}

static int slim_command_has_option(const char *command, const char *option) {
  int option_length = 0;
  const char *p = option;
  while (*p) { ++option_length; ++p; }
  while (*command) {
    const char *start, *end;
    int i;
    while (*command == ' ' || *command == '\t') ++command;
    if (!*command) break;
    if (*command == '"') {
      start = ++command;
      while (*command && *command != '"') ++command;
      end = command;
      if (*command) ++command;
    } else {
      start = command;
      while (*command && *command != ' ' && *command != '\t') ++command;
      end = command;
    }
    if (end - start != option_length) continue;
    for (i = 0; i < option_length && start[i] == option[i]; ++i) { }
    if (i == option_length) return 1;
  }
  return 0;
}

static int slim_create_offscreen_surface(int width, int height) {
  BITMAPINFO info;
  int left, top, view_width, view_height;
  slim_u32 *pixels = 0;
  slim_fit_viewport(width, height, &left, &top, &view_width, &view_height);
  if (!slim_framebuffer_size_valid(width, height) ||
      !slim_framebuffer_size_valid(view_width, view_height)) return 0;
  slim_surface_dc = CreateCompatibleDC(0);
  if (!slim_surface_dc) return 0;
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  info.bmiHeader.biSizeImage = 0;
  info.bmiHeader.biXPelsPerMeter = 0;
  info.bmiHeader.biYPelsPerMeter = 0;
  info.bmiHeader.biClrUsed = 0;
  info.bmiHeader.biClrImportant = 0;
  info.bmiColors[0].rgbBlue = 0;
  info.bmiColors[0].rgbGreen = 0;
  info.bmiColors[0].rgbRed = 0;
  info.bmiColors[0].rgbReserved = 0;
  slim_surface_bitmap = CreateDIBSection(slim_surface_dc, &info, DIB_RGB_COLORS,
                                         (void **)&pixels, 0, 0);
  if (!slim_surface_bitmap || !pixels) {
    if (slim_surface_bitmap) DeleteObject(slim_surface_bitmap);
    DeleteDC(slim_surface_dc);
    slim_surface_dc = 0;
    slim_surface_bitmap = 0;
    return 0;
  }
  slim_surface_previous = (HBITMAP)SelectObject(slim_surface_dc, slim_surface_bitmap);
  if (!slim_surface_previous || slim_surface_previous == (HBITMAP)HGDI_ERROR) {
    DeleteObject(slim_surface_bitmap);
    DeleteDC(slim_surface_dc);
    slim_surface_dc = 0;
    slim_surface_bitmap = 0;
    return 0;
  }
  slim_surface_pixels = pixels;
  slim_surface_width = width;
  slim_surface_height = height;
  slim_zero_pixels(pixels, (SIZE_T)width * (SIZE_T)height);
  slim_bind_framebuffer(pixels + top * width + left, view_width, view_height, width);
  return 1;
}

static int slim_run_offscreen_benchmark(int width, int height, int frames, int play) {
  LARGE_INTEGER frequency, start, end;
  SlimBenchmarkResult result;
  int i;
  if (frames < 1 || !slim_create_offscreen_surface(width, height)) return 0;
  slim_clear();
  slim_init();
  if (play) slim_pressed = 1;
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&start);
  for (i = 0; i < frames; ++i) {
    GdiFlush();
#if SLIM_HAS_TEXT
    slim_text_command_count = 0;
#endif
    slim_clear();
    slim_frame();
#if SLIM_HAS_TEXT
    slim_compose_text();
#endif
    if (i == 0) {
      slim_pending_directions[0] = 0;
      slim_pending_directions[1] = 0;
      slim_pending_directions[2] = 0;
      slim_pending_directions[3] = 0;
      slim_pressed = 0;
      slim_restart_pressed = 0;
      slim_menu_pressed = 0;
    }
  }
  QueryPerformanceCounter(&end);
  result.presents = (uint64_t)frames;
  result.ticks = (uint64_t)frames;
  result.elapsed = (uint64_t)(end.QuadPart - start.QuadPart);
  result.frequency = (uint64_t)frequency.QuadPart;
  result.work = result.elapsed;
  result.framebuffer_width = (uint32_t)slim_fb_width;
  result.framebuffer_height = (uint32_t)slim_fb_height;
  result.client_width = (uint32_t)width;
  result.client_height = (uint32_t)height;
  result.window_dpi = 0;
  result.dpi_awareness = 0;
  slim_write_offscreen_benchmark(&result);
  if (!slim_write_composed_bmp()) return 0;
  GdiFlush();
  SelectObject(slim_surface_dc, slim_surface_previous);
  DeleteObject(slim_surface_bitmap);
  DeleteDC(slim_surface_dc);
  slim_surface_dc = 0;
  slim_surface_bitmap = 0;
  slim_surface_previous = 0;
  slim_surface_pixels = 0;
  slim_surface_width = 0;
  slim_surface_height = 0;
  slim_bind_framebuffer(0, 0, 0, 0);
  return 1;
}

static int slim_run_smoke(void) {
  int i, count, smoke;
  slim_u32 *pixels;
  const char *command = GetCommandLineA();
  count = slim_smoke_ticks(command, &smoke);
  if (!smoke) return 0;
  if (slim_command_has_option(command, "--offscreen")) {
    int width = slim_command_has_option(command, "--large") ? 1280 : 800;
    int height = width * 3 / 4;
    int play = slim_command_has_option(command, "--play");
    if (!slim_run_offscreen_benchmark(width, height, count, play)) ExitProcess(2);
    ExitProcess(0);
  }
  pixels = (slim_u32 *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                 (SIZE_T)800 * 600 * sizeof(slim_u32));
  if (!pixels) ExitProcess(2);
  slim_bind_framebuffer(pixels, 800, 600, 800);
  slim_clear();
  slim_init();
  for (i = 0; i < count; ++i) {
#if SLIM_HAS_TEXT
    slim_text_command_count = 0;
#endif
    slim_clear();
    slim_frame();
    slim_pressed = slim_restart_pressed = slim_menu_pressed = 0;
  }
  if (!slim_write_smoke_bmp()) ExitProcess(2);
  ExitProcess(0);
  return 1;
}
#endif

static void slim_set_dpi_awareness(void) {
  typedef BOOL (WINAPI *SlimSetDpiContext)(HANDLE);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  SlimSetDpiContext set_context = user32 ? (SlimSetDpiContext)GetProcAddress(user32, "SetProcessDpiAwarenessContext") : 0;
  if (!set_context || !set_context((HANDLE)(LONG_PTR)-4)) SetProcessDPIAware();
}

static void slim_set_client_size(HWND window, int client_width, int client_height, DWORD style) {
  RECT outer = {0, 0, client_width, client_height};
  int width, height, attempt;
  AdjustWindowRect(&outer, style, FALSE);
  width = outer.right - outer.left;
  height = outer.bottom - outer.top;
  ShowWindow(window, SW_RESTORE);
  for (attempt = 0; attempt < 3; ++attempt) {
    RECT client;
    SetWindowPos(window, 0, 100, 100, width, height,
                 SWP_NOZORDER | SWP_NOACTIVATE);
    if (!GetClientRect(window, &client)) return;
    if (client.right - client.left == client_width &&
        client.bottom - client.top == client_height) return;
    width += client_width - (client.right - client.left);
    height += client_height - (client.bottom - client.top);
  }
}

static int slim_run_window(void) {
  WNDCLASSEXW wc;
  RECT client;
  DWORD style = WS_OVERLAPPEDWINDOW;
  HWND window;
  MSG message;
  int desired_width = 800, desired_height = 600;
  LARGE_INTEGER frequency, next_tick, now;
  LONGLONG frame_ticks;
#if SLIM_SMOKE
  int benchmark = slim_benchmark_requested();
  int large_benchmark = slim_large_benchmark_requested();
  int game_benchmark = slim_game_benchmark_requested();
  uint64_t benchmark_presents = 0, benchmark_ticks = 0, benchmark_work = 0;
  LARGE_INTEGER benchmark_start, benchmark_work_start, benchmark_work_end;
#endif
  int timer_resolution_requested = 0;
  slim_set_dpi_awareness();
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = slim_window_proc;
  wc.cbClsExtra = 0;
  wc.cbWndExtra = 0;
  wc.hInstance = GetModuleHandleW(0);
  wc.hIcon = 0;
  wc.hCursor = LoadCursorW(0, (LPCWSTR)IDC_ARROW);
  wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
  wc.lpszMenuName = 0;
  wc.lpszClassName = L"SLIMNativeGame";
  wc.hIconSm = 0;
  if (!RegisterClassExW(&wc)) return 1;
  client.left = 0;
  client.top = 0;
#if SLIM_SMOKE
  if (benchmark && large_benchmark) {
    desired_width = 1280;
    desired_height = 960;
  }
#endif
  client.right = desired_width;
  client.bottom = desired_height;
  AdjustWindowRect(&client, style, FALSE);
  window = CreateWindowExW(0, wc.lpszClassName, L"SLIM native game", style,
                           100, 100, client.right - client.left,
                           client.bottom - client.top, 0, 0, wc.hInstance, 0);
  if (!window) return 1;
  slim_window = window;
  if (!slim_prepare_framebuffer(window)) {
    DestroyWindow(window);
    slim_window = 0;
    if (slim_surface_dc) {
      SelectObject(slim_surface_dc, slim_surface_previous);
      DeleteObject(slim_surface_bitmap);
      DeleteDC(slim_surface_dc);
      slim_surface_dc = 0;
      slim_surface_bitmap = 0;
      slim_surface_previous = 0;
      slim_surface_pixels = 0;
    }
    slim_bind_framebuffer(0, 0, 0, 0);
    return 1;
  }
  ShowWindow(window, SW_SHOWNORMAL);
  slim_set_client_size(window, desired_width, desired_height, style);
  UpdateWindow(window);
  slim_clear();
  slim_init();
#if SLIM_SMOKE
  if (benchmark && game_benchmark) slim_pressed = 1;
#endif
#if SLIM_HAS_SOUND
  slim_audio_start();
#endif
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&next_tick);
#if SLIM_SMOKE
  QueryPerformanceCounter(&benchmark_start);
#endif
  frame_ticks = frequency.QuadPart / 60;
  if (frame_ticks < 1) frame_ticks = 1;
  timer_resolution_requested = timeBeginPeriod(1) == TIMERR_NOERROR;
  next_tick.QuadPart += frame_ticks;
  slim_running = 1;
  while (slim_running) {
    while (PeekMessageW(&message, 0, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) slim_running = 0;
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    if (!slim_running) break;
    QueryPerformanceCounter(&now);
    if (now.QuadPart >= next_tick.QuadPart) {
      LONGLONG behind = now.QuadPart - next_tick.QuadPart;
      LONGLONG due_ticks = behind / frame_ticks + 1;
      int steps = due_ticks > 5 ? 5 : (int)due_ticks;
#if SLIM_SMOKE
      if (benchmark) QueryPerformanceCounter(&benchmark_work_start);
#endif
      if (!slim_prepare_framebuffer(window)) {
        Sleep(1);
        continue;
      }
      {
        int step;
        for (step = 0; step < steps; ++step) {
          if (step == 0) GdiFlush();
#if SLIM_HAS_TEXT
          slim_text_command_count = 0;
#endif
          slim_clear();
          slim_frame();
          if (step == 0) {
            slim_pending_directions[0] = 0;
            slim_pending_directions[1] = 0;
            slim_pending_directions[2] = 0;
            slim_pending_directions[3] = 0;
            slim_pressed = 0;
            slim_restart_pressed = 0;
            slim_menu_pressed = 0;
          }
        }
      }
#if SLIM_HAS_TEXT
      slim_compose_text();
#endif
      slim_present();
      if (due_ticks > 5) {
        QueryPerformanceCounter(&now);
        next_tick.QuadPart = now.QuadPart + frame_ticks;
      } else {
        next_tick.QuadPart += (LONGLONG)steps * frame_ticks;
      }
#if SLIM_SMOKE
      if (benchmark) {
        QueryPerformanceCounter(&benchmark_work_end);
        ++benchmark_presents;
        benchmark_ticks += (uint64_t)steps;
        benchmark_work += (uint64_t)(benchmark_work_end.QuadPart - benchmark_work_start.QuadPart);
        if (benchmark_work_end.QuadPart - benchmark_start.QuadPart >= frequency.QuadPart * 5) {
          SlimBenchmarkResult result;
          result.presents = benchmark_presents;
          result.ticks = benchmark_ticks;
          result.elapsed = (uint64_t)(benchmark_work_end.QuadPart - benchmark_start.QuadPart);
          result.frequency = (uint64_t)frequency.QuadPart;
          result.work = benchmark_work;
          result.framebuffer_width = (uint32_t)slim_fb_width;
          result.framebuffer_height = (uint32_t)slim_fb_height;
          {
            typedef UINT (WINAPI *SlimGetDpiForWindow)(HWND);
            typedef HANDLE (WINAPI *SlimGetWindowDpiContext)(HWND);
            typedef int (WINAPI *SlimGetDpiAwareness)(HANDLE);
            HMODULE user32 = GetModuleHandleW(L"user32.dll");
            SlimGetDpiForWindow get_dpi = user32 ? (SlimGetDpiForWindow)GetProcAddress(user32, "GetDpiForWindow") : 0;
            SlimGetWindowDpiContext get_context = user32 ? (SlimGetWindowDpiContext)GetProcAddress(user32, "GetWindowDpiAwarenessContext") : 0;
            SlimGetDpiAwareness get_awareness = user32 ? (SlimGetDpiAwareness)GetProcAddress(user32, "GetAwarenessFromDpiAwarenessContext") : 0;
            RECT measured_client;
            if (GetClientRect(window, &measured_client)) {
              result.client_width = (uint32_t)(measured_client.right - measured_client.left);
              result.client_height = (uint32_t)(measured_client.bottom - measured_client.top);
            } else result.client_width = result.client_height = 0;
            result.window_dpi = get_dpi ? get_dpi(window) : 0;
            result.dpi_awareness = get_context && get_awareness ? (uint32_t)get_awareness(get_context(window)) : 0;
          }
          slim_write_benchmark(&result);
          slim_write_composed_bmp();
          DestroyWindow(window);
          break;
        }
      }
#endif
    } else {
      LONGLONG remaining = next_tick.QuadPart - now.QuadPart;
      DWORD sleep_ms = (DWORD)((remaining * 1000) / frequency.QuadPart);
      if (sleep_ms > 1) Sleep(sleep_ms - 1);
      else Sleep(1);
    }
  }
#if SLIM_HAS_SOUND
  slim_audio_stop();
#endif
  if (timer_resolution_requested) timeEndPeriod(1);
  if (slim_surface_dc) {
    SelectObject(slim_surface_dc, slim_surface_previous);
    DeleteObject(slim_surface_bitmap);
    DeleteDC(slim_surface_dc);
    slim_surface_dc = 0;
    slim_surface_bitmap = 0;
    slim_surface_previous = 0;
    slim_surface_pixels = 0;
  }
  slim_bind_framebuffer(0, 0, 0, 0);
  return 0;
}

void WINAPI slim_windows_entry(void) {
#if SLIM_SMOKE
  slim_run_smoke();
#endif
  ExitProcess((UINT)slim_run_window());
}
