use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, Once};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Disks, Networks, System};
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    name: String,
    util: f32,               // % obciążenia
    vram_used: u64,          // bajty
    vram_total: Option<u64>, // bajty (nie zawsze znane)
    temp: Option<f32>,       // °C (tylko NVIDIA)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    mount: String,
    used: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    cpu_name: String,
    cpu_total: f32,
    cpus: Vec<f32>,
    mem_used: u64,
    mem_total: u64,
    swap_used: u64,
    swap_total: u64,
    net_rx: u64, // bajty/s
    net_tx: u64,
    disks: Vec<DiskInfo>,
    uptime: u64, // sekundy
    gpu: Option<GpuInfo>,
}

struct Inner {
    sys: System,
    nets: Networks,
    disks: Disks,
    last_net: Instant,
}

pub struct MonitorState {
    inner: Mutex<Inner>,
    gpu: Arc<Mutex<Option<GpuInfo>>>,
    gpu_started: Once,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                sys: System::new(),
                nets: Networks::new_with_refreshed_list(),
                disks: Disks::new_with_refreshed_list(),
                last_net: Instant::now(),
            }),
            gpu: Arc::new(Mutex::new(None)),
            gpu_started: Once::new(),
        }
    }
}

/// Komenda bez migającego okna konsoli na Windowsie.
fn hidden(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// NVIDIA: nvidia-smi raz na sekundę. Zwraca false, jeśli nvidia-smi nie istnieje.
fn gpu_nvidia_loop(out: &Arc<Mutex<Option<GpuInfo>>>) -> bool {
    let query = || {
        hidden("nvidia-smi")
            .args([
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    if query().is_none() {
        return false;
    }
    loop {
        if let Some(text) = query() {
            // pierwsza karta: "NVIDIA GeForce RTX 3060, 12, 1024, 12288, 45"
            let f: Vec<&str> = text.lines().next().unwrap_or("").split(',').map(str::trim).collect();
            if f.len() >= 5 {
                let mib = |s: &str| s.parse::<u64>().ok().map(|v| v * 1024 * 1024);
                *out.lock().unwrap() = Some(GpuInfo {
                    name: f[0].to_string(),
                    util: f[1].parse().unwrap_or(0.0),
                    vram_used: mib(f[2]).unwrap_or(0),
                    vram_total: mib(f[3]),
                    temp: f[4].parse().ok(),
                });
            }
        }
        thread::sleep(Duration::from_secs(1));
    }
}

/// Każda karta na Windowsie: liczniki wydajności (to samo co Menedżer zadań)
/// czytane przez jeden ukryty, długo żyjący PowerShell, który co ~1 s wypisuje linię
/// "util|vram_used|vram_total|nazwa".
#[cfg(windows)]
fn gpu_counters_loop(out: &Arc<Mutex<Option<GpuInfo>>>) {
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$vc = Get-CimInstance Win32_VideoController | Sort-Object AdapterRAM -Descending | Select-Object -First 1
$name = $vc.Name
$total = 0
$key = Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' |
  Where-Object { (Get-ItemProperty $_.PSPath).DriverDesc -eq $name } | Select-Object -First 1
if ($key) { $total = (Get-ItemProperty $key.PSPath).'HardwareInformation.qwMemorySize' }
if (-not $total) { $total = $vc.AdapterRAM }
while ($true) {
  $u = (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage').CounterSamples | Measure-Object CookedValue -Sum
  $m = (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples | Measure-Object CookedValue -Maximum
  [Console]::Out.WriteLine(('{0}|{1}|{2}|{3}' -f [int]$u.Sum, [int64]$m.Maximum, [int64]$total, $name))
  [Console]::Out.Flush()
}
"#;
    let child = hidden("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return };
    let Some(stdout) = child.stdout.take() else { return };
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let f: Vec<&str> = line.splitn(4, '|').collect();
        if f.len() == 4 {
            let total = f[2].parse::<u64>().ok().filter(|&t| t > 0);
            *out.lock().unwrap() = Some(GpuInfo {
                name: f[3].trim().to_string(),
                util: f[0].parse::<f32>().unwrap_or(0.0).min(100.0),
                vram_used: f[1].parse().unwrap_or(0),
                vram_total: total,
                temp: None,
            });
        }
    }
}

#[cfg(not(windows))]
fn gpu_counters_loop(_out: &Arc<Mutex<Option<GpuInfo>>>) {}

#[tauri::command]
pub async fn system_stats(state: State<'_, MonitorState>) -> Result<Stats, String> {
    // wątek GPU startuje przy pierwszym otwarciu monitora i działa w tle
    state.gpu_started.call_once(|| {
        let out = state.gpu.clone();
        thread::spawn(move || {
            if !gpu_nvidia_loop(&out) {
                gpu_counters_loop(&out);
            }
        });
    });

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let inner = &mut *guard;
    inner.sys.refresh_cpu_usage();
    inner.sys.refresh_memory();
    inner.nets.refresh(true);
    inner.disks.refresh(true);

    // sieć: bajty od poprzedniego odświeżenia / czas, który minął
    let secs = inner.last_net.elapsed().as_secs_f64().max(0.001);
    inner.last_net = Instant::now();
    let (rx, tx) = inner
        .nets
        .iter()
        .fold((0u64, 0u64), |(r, t), (_, d)| (r + d.received(), t + d.transmitted()));

    let cpus: Vec<f32> = inner.sys.cpus().iter().map(|c| c.cpu_usage()).collect();
    let cpu_total = if cpus.is_empty() { 0.0 } else { cpus.iter().sum::<f32>() / cpus.len() as f32 };
    let cpu_name = inner.sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();

    let mut disks: Vec<DiskInfo> = inner
        .disks
        .iter()
        .filter(|d| d.total_space() > 0)
        .map(|d| DiskInfo {
            mount: d.mount_point().to_string_lossy().into_owned(),
            used: d.total_space() - d.available_space(),
            total: d.total_space(),
        })
        .collect();
    disks.sort_by(|a, b| a.mount.cmp(&b.mount));
    disks.dedup_by(|a, b| a.mount == b.mount);

    Ok(Stats {
        cpu_name,
        cpu_total, // średnia rdzeni, jak w Menedżerze zadań
        cpus,
        mem_used: inner.sys.used_memory(),
        mem_total: inner.sys.total_memory(),
        swap_used: inner.sys.used_swap(),
        swap_total: inner.sys.total_swap(),
        net_rx: (rx as f64 / secs) as u64,
        net_tx: (tx as f64 / secs) as u64,
        disks,
        uptime: System::uptime(),
        gpu: state.gpu.lock().map_err(|e| e.to_string())?.clone(),
    })
}
