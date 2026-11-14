use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

const TRAY_ID: &str = "main-tray";

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Mirror the web app's unread count onto the dock badge and the tray title.
#[tauri::command]
fn set_unread(app: AppHandle, count: i64) {
    let unread = count.max(0);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count(if unread > 0 { Some(unread) } else { None });
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let title = if unread > 0 { Some(unread.to_string()) } else { None };
        let _ = tray.set_title(title.as_deref());
        let tooltip = if unread > 0 {
            format!("ELPA · 안 읽은 메시지 {unread}개")
        } else {
            "ELPA".to_string()
        };
        let _ = tray.set_tooltip(Some(tooltip.as_str()));
    }
}

/// Native notification, e.g. when a requested task is completed.
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // A second launch focuses the running window instead of starting another copy.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![set_unread, notify])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "ELPA 열기", true, None::<&str>)?;
            let quick = MenuItem::with_id(app, "quick-add", "새 할 일", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quick, &quit])?;

            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("ELPA")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quick-add" => {
                        show_main(app);
                        let _ = app.emit("quick-add", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        // Closing the window keeps the app alive in the tray; "종료" quits for real.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the ELPA desktop app");

    app.run(|_app, _event| {
        // Clicking the dock icon brings the hidden window back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            show_main(_app);
        }
    });
}
