#![windows_subsystem = "windows"]

// This program replicates the AutoHotkey script:
//
//   ^!e::Send('è')
//   ^!a::Send('à')
//   ^!i::Send('ì')
//   ^!o::Send('ò')
//   ^!u::Send('ù')
//
// using Rust and windows-rs. It registers global hotkeys
// and provides a tray icon with an “Exit” menu item.
//
// Keys:
//   Ctrl+Alt+E -> è
//   Ctrl+Alt+A -> à
//   Ctrl+Alt+I -> ì
//   Ctrl+Alt+O -> ò
//   Ctrl+Alt+U -> ù

use std::mem::{size_of, zeroed};
use std::ptr::null;

use windows::Win32::Foundation::{GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::HBRUSH;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, SendInput,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, VIRTUAL_KEY};
use windows::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
    Shell_NotifyIconW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
    DestroyMenu, DispatchMessageW, GWL_WNDPROC, GetCursorPos, GetMessageW, HCURSOR, HICON, HMENU,
    IDI_APPLICATION, InsertMenuW, LoadIconW, MB_OK, MF_BYPOSITION, MSG, MessageBoxW,
    PostQuitMessage, RegisterClassW, SetForegroundWindow, SetMenuDefaultItem, SetWindowLongPtrW,
    TPM_BOTTOMALIGN, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenuEx,
    TranslateMessage, UnregisterClassW, WM_COMMAND, WM_DESTROY, WM_HOTKEY, WM_RBUTTONUP, WM_USER,
    WNDCLASSW, WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};
use windows::core::PCWSTR;

// Hotkey IDs
const HOTKEY_ID_E: i32 = 1;
const HOTKEY_ID_A: i32 = 2;
const HOTKEY_ID_I: i32 = 3;
const HOTKEY_ID_O: i32 = 4;
const HOTKEY_ID_U: i32 = 5;

// Tray menu command IDs
const ID_TRAY_EXIT: u16 = 1000;

// Custom tray callback message
const WM_TRAYICON: u32 = WM_USER + 1;

// MOD_* from WinUser.h
const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;

// VIRTUAL-KEY codes for letters
const VK_A: u32 = 0x41;
const VK_E: u32 = 0x45;
const VK_I: u32 = 0x49;
const VK_O: u32 = 0x4F;
const VK_U: u32 = 0x55;

// Simple helper: convert &str -> wide null-terminated UTF-16
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// Show a message box and exit the process
fn fatal(msg: &str) -> ! {
    let w = to_wide(msg);
    unsafe {
        MessageBoxW(
            HWND(std::ptr::null_mut()),
            PCWSTR(w.as_ptr()),
            PCWSTR(w.as_ptr()),
            MB_OK,
        );
    }
    std::process::exit(1);
}

// Send a single Unicode character via SendInput
unsafe fn send_unicode_char(ch: char) {
    unsafe {
        let mut input_down: INPUT = zeroed();
        input_down.r#type = INPUT_KEYBOARD;
        let mut ki_down: KEYBDINPUT = Default::default();
        ki_down.wVk = VIRTUAL_KEY(0);
        ki_down.wScan = ch as u16;
        ki_down.dwFlags = KEYEVENTF_UNICODE;
        ki_down.time = 0;
        ki_down.dwExtraInfo = 0;
        input_down.Anonymous = INPUT_0 { ki: ki_down };

        let mut input_up: INPUT = zeroed();
        input_up.r#type = INPUT_KEYBOARD;
        let mut ki_up: KEYBDINPUT = Default::default();
        ki_up.wVk = VIRTUAL_KEY(0);
        ki_up.wScan = ch as u16;
        ki_up.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        ki_up.time = 0;
        ki_up.dwExtraInfo = 0;
        input_up.Anonymous = INPUT_0 { ki: ki_up };

        let inputs = [input_down, input_up];
        let sent = SendInput(&inputs, size_of::<INPUT>() as i32);

        if sent == 0 {
            let err = GetLastError().0;
            let msg = format!("SendInput failed with error {err}");
            fatal(&msg);
        }
    }
}

// Create and show tray context menu. Returns command ID (e.g. ID_TRAY_EXIT) or 0.
unsafe fn show_tray_menu(hwnd: HWND) -> u16 {
    unsafe {
        let h_menu = match CreatePopupMenu() {
            Ok(m) => m,
            Err(_) => fatal("CreatePopupMenu failed"),
        };

        // Insert "Exit" at position 0 (MF_BYPOSITION)
        let text = to_wide("Exit");
        let _ = InsertMenuW(
            h_menu,
            u32::MAX,
            MF_BYPOSITION,
            ID_TRAY_EXIT as usize,
            PCWSTR(text.as_ptr()),
        );

        // Make Exit default (bold)
        SetMenuDefaultItem(h_menu, ID_TRAY_EXIT as u32, 0);

        // Required so the menu closes correctly when clicking elsewhere
        SetForegroundWindow(hwnd);

        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);

        let flags = (TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON | TPM_RETURNCMD).0;
        let cmd = TrackPopupMenuEx(h_menu, flags, pt.x, pt.y, hwnd, None);

        DestroyMenu(h_menu);
        cmd.0 as u16
    }
}

// Add tray icon
unsafe fn add_tray_icon(hwnd: HWND, hinstance: HINSTANCE) {
    unsafe {
        let mut nid: NOTIFYICONDATAW = zeroed();
        nid.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = hwnd;
        nid.uID = 1;
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        nid.uCallbackMessage = WM_TRAYICON;

        // Default application icon
        let h_icon = match LoadIconW(hinstance, IDI_APPLICATION) {
            Ok(icon) => icon,
            Err(_) => HICON(std::ptr::null_mut()),
        };
        nid.hIcon = h_icon;

        // Tooltip
        let tip = to_wide("Italian accents hotkey");
        // NOTIFYICONDATAW::szTip is [u16; 128]
        let max = nid.szTip.len().min(tip.len());
        nid.szTip[..max].copy_from_slice(&tip[..max]);

        let ok = Shell_NotifyIconW(NIM_ADD, &nid);
        if !ok.as_bool() {
            fatal("Shell_NotifyIconW(NIM_ADD) failed");
        }
    }
}

// Update tray icon tooltip
unsafe fn update_tray_tooltip(hwnd: HWND, text: &str) {
    unsafe {
        let mut nid: NOTIFYICONDATAW = zeroed();
        nid.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = hwnd;
        nid.uID = 1;
        nid.uFlags = NIF_TIP;

        let tip = to_wide(text);
        let max = nid.szTip.len().min(tip.len());
        nid.szTip[..max].copy_from_slice(&tip[..max]);

        let _ = Shell_NotifyIconW(NIM_MODIFY, &nid);
    }
}

// Remove tray icon
unsafe fn remove_tray_icon(hwnd: HWND) {
    unsafe {
        let mut nid: NOTIFYICONDATAW = zeroed();
        nid.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = hwnd;
        nid.uID = 1;

        let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
    }
}

// Window procedure
extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_HOTKEY => {
                match wparam.0 as i32 {
                    HOTKEY_ID_E => send_unicode_char('è'),
                    HOTKEY_ID_A => send_unicode_char('à'),
                    HOTKEY_ID_I => send_unicode_char('ì'),
                    HOTKEY_ID_O => send_unicode_char('ò'),
                    HOTKEY_ID_U => send_unicode_char('ù'),
                    _ => {}
                }
                LRESULT(0)
            }
            WM_TRAYICON => {
                if lparam.0 as u32 == WM_RBUTTONUP {
                    let cmd = show_tray_menu(hwnd);
                    if cmd == ID_TRAY_EXIT {
                        PostQuitMessage(0);
                    }
                }
                LRESULT(0)
            }
            WM_COMMAND => {
                let cmd_id = (wparam.0 & 0xFFFF) as u16;
                if cmd_id == ID_TRAY_EXIT {
                    PostQuitMessage(0);
                    return LRESULT(0);
                }
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            WM_DESTROY => {
                remove_tray_icon(hwnd);
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

fn main() {
    unsafe {
        // Get module handle
        let hinstance = match GetModuleHandleW(PCWSTR(null())) {
            Ok(h) => HINSTANCE(h.0),
            Err(_) => fatal("GetModuleHandleW failed"),
        };

        // Register window class
        let class_name = to_wide("HotkeyTrayWindowClass");
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: HICON(std::ptr::null_mut()),
            hCursor: HCURSOR(std::ptr::null_mut()),
            hbrBackground: HBRUSH(std::ptr::null_mut()),
            lpszMenuName: PCWSTR(null()),
            lpszClassName: PCWSTR(class_name.as_ptr()),
        };

        if RegisterClassW(&wc) == 0 {
            fatal("RegisterClassW failed");
        }

        // Create a hidden tool window (no taskbar button)
        let window_name = to_wide("HotkeyTrayWindow");
        let hwnd = match CreateWindowExW(
            WS_EX_TOOLWINDOW,
            PCWSTR(class_name.as_ptr()),
            PCWSTR(window_name.as_ptr()),
            WS_OVERLAPPEDWINDOW & !WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            HWND(std::ptr::null_mut()),
            HMENU(std::ptr::null_mut()),
            hinstance,
            None,
        ) {
            Ok(h) => h,
            Err(_) => fatal("CreateWindowExW failed"),
        };

        // Ensure our wnd_proc is set
        SetWindowLongPtrW(hwnd, GWL_WNDPROC, wnd_proc as isize);

        // Register hotkeys
        let mods = MOD_CONTROL | MOD_ALT;

        use windows::Win32::UI::Input::KeyboardAndMouse::HOT_KEY_MODIFIERS;

        if RegisterHotKey(hwnd, HOTKEY_ID_E, HOT_KEY_MODIFIERS(mods), VK_E).is_err() {
            fatal("RegisterHotKey Ctrl+Alt+E failed");
        }
        if RegisterHotKey(hwnd, HOTKEY_ID_A, HOT_KEY_MODIFIERS(mods), VK_A).is_err() {
            fatal("RegisterHotKey Ctrl+Alt+A failed");
        }
        if RegisterHotKey(hwnd, HOTKEY_ID_I, HOT_KEY_MODIFIERS(mods), VK_I).is_err() {
            fatal("RegisterHotKey Ctrl+Alt+I failed");
        }
        if RegisterHotKey(hwnd, HOTKEY_ID_O, HOT_KEY_MODIFIERS(mods), VK_O).is_err() {
            fatal("RegisterHotKey Ctrl+Alt+O failed");
        }
        if RegisterHotKey(hwnd, HOTKEY_ID_U, HOT_KEY_MODIFIERS(mods), VK_U).is_err() {
            fatal("RegisterHotKey Ctrl+Alt+U failed");
        }

        // Add tray icon and tooltip
        add_tray_icon(hwnd, hinstance);
        update_tray_tooltip(hwnd, "lu2000luk's italian remap");

        // Message loop
        let mut msg: MSG = zeroed();
        loop {
            let res = GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0);
            if res.0 == -1 {
                fatal("GetMessageW failed");
            }
            if res.0 == 0 {
                break;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        // Cleanup
        UnregisterHotKey(hwnd, HOTKEY_ID_E);
        UnregisterHotKey(hwnd, HOTKEY_ID_A);
        UnregisterHotKey(hwnd, HOTKEY_ID_I);
        UnregisterHotKey(hwnd, HOTKEY_ID_O);
        UnregisterHotKey(hwnd, HOTKEY_ID_U);

        let _ = UnregisterClassW(PCWSTR(class_name.as_ptr()), hinstance);
    }
}
