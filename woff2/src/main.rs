#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use woff2_patched::decode::{convert_woff2_to_ttf, is_woff2};

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MESSAGEBOX_STYLE};

fn main() {
    // When a file is dragged onto the EXE or opened via "Open with", the path appears as the first arg.
    let mut args = env::args_os();
    let _exe = args.next(); // skip program name
    let Some(input_os) = args.next() else {
        // No file provided: exit silently (common for drag-and-drop utilities when double-clicked).
        return;
    };

    let input_path = PathBuf::from(input_os);

    // Read file
    let buffer = match fs::read(&input_path) {
        Ok(b) => b,
        Err(_) => {
            message_box("Failed to read the file.", "woff2decomp");
            return;
        }
    };

    // Validate content is WOFF2
    if !is_woff2(&buffer) {
        message_box("Invalid file type", "woff2decomp");
        return;
    }

    // Convert WOFF2 -> TTF
    let mut cursor = Cursor::new(buffer);
    let ttf_bytes = match convert_woff2_to_ttf(&mut cursor) {
        Ok(ttf) => ttf,
        Err(_) => {
            message_box("Conversion failed.", "woff2decomp");
            return;
        }
    };

    // Build output path (same filename, .ttf extension)
    let mut output_path = input_path.clone();
    output_path.set_extension("ttf");

    // Write TTF
    if let Err(_) = fs::write(&output_path, ttf_bytes) {
        message_box("Failed to write the .ttf file.", "woff2decomp");
        return;
    }

    // Success: no message shown to keep drag-and-drop workflow clean.
}

fn message_box(text: &str, caption: &str) {
    #[cfg(target_os = "windows")]
    {
        let text_w = to_wide(text);
        let caption_w = to_wide(caption);
        unsafe {
            let _ = MessageBoxW(
                HWND(std::ptr::null_mut()),
                PCWSTR::from_raw(text_w.as_ptr()),
                PCWSTR::from_raw(caption_w.as_ptr()),
                MESSAGEBOX_STYLE(MB_OK.0 | MB_ICONERROR.0),
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        eprintln!("{caption}: {text}");
    }
}

#[cfg(target_os = "windows")]
fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
