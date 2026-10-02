using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MapArtController;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        if (args.Contains("--self-test", StringComparer.Ordinal))
        {
            try { using var form = new ControllerForm(); return 0; }
            catch { return 1; }
        }
        try { Application.Run(new ControllerForm()); return 0; }
        catch (Exception error) { MessageBox.Show(error.Message, "地图画控制台无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
    }
}

internal sealed class JobInfo
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Schematic { get; init; } = "";
    public string Position { get; init; } = "";
    public int Done { get; init; }
    public int Total { get; init; }
    public double Percent { get; init; }
    public override string ToString() => Name;
}

internal sealed class ControllerForm : Form
{
    private static readonly Color Ink = Color.FromArgb(60, 43, 70);
    private static readonly Color Sub = Color.FromArgb(126, 103, 135);
    private static readonly Color Violet = Color.FromArgb(224, 89, 153);
    private static readonly Color Blue = Color.FromArgb(173, 110, 204);
    private static readonly Color Background = Color.FromArgb(255, 248, 252);
    private static readonly Color Pale = Color.FromArgb(252, 235, 246);
    private static readonly Color Red = Color.FromArgb(183, 65, 98);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            int caption = ColorTranslator.ToWin32(Color.FromArgb(220, 105, 172));
            int captionText = ColorTranslator.ToWin32(Color.White);
            _ = DwmSetWindowAttribute(Handle, 35, ref caption, sizeof(int));
            _ = DwmSetWindowAttribute(Handle, 36, ref captionText, sizeof(int));
        }
        catch { /* Older Windows versions keep their normal title bar. */ }
    }

    private readonly string _root;
    private readonly string _node;
    private readonly HttpClient _http;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 5000 };
    private readonly Label _serviceLabel = new();
    private readonly Label _selectedTitle = new();
    private readonly Label _selectedMeta = new();
    private readonly Label _runState = new();
    private readonly ListBox _jobs = new();
    private readonly Label _emptyJobs = new();
    private readonly RichTextBox _logs = new();
    private readonly WebView2 _webView = new();
    private readonly Label _offlineMessage = new();
    private readonly CheckBox _followLogs = new();
    private readonly ToolTip _tooltips = new();
    private readonly List<string> _localLogs = new();
    private readonly Button _startWeb;
    private readonly Button _stopWeb;
    private readonly Button _openWeb;
    private readonly Button _openStudio;
    private readonly Button _openSites;
    private readonly Button _refresh;
    private readonly Button _single;
    private readonly Button _dual;
    private readonly Button _preflight;
    private readonly Button _verify;
    private readonly Button _repair;
    private readonly Button _stopBot;
    private readonly Button _leftLogin;
    private readonly Button _selfCheck;
    private readonly int _port;
    private readonly string _baseUrl;
    private Process? _dashboardProcess;
    private Process? _toolProcess;
    private bool _serviceOnline;
    private bool _botRunning;
    private bool _refreshing;
    private bool _startingWeb;
    private bool _closingApproved;
    private bool _webInitialized;
    private bool _webInitializing;
    private bool _webWasOnline;
    private string _requestedPath = "/";
    private string _serverLogs = "";
    private string _shownLogs = "";

    public ControllerForm()
    {
        _root = FindProjectRoot();
        _node = FindOnPath("node.exe") ?? throw new InvalidOperationException("找不到 node.exe。请先安装 Node.js 并确保它在 PATH 中。");
        _port = int.TryParse(Environment.GetEnvironmentVariable("MAPART_DASHBOARD_PORT"), out int port) && port is > 0 and < 65536 ? port : 32124;
        _baseUrl = $"http://127.0.0.1:{_port}";
        _http = new HttpClient { BaseAddress = new Uri(_baseUrl), Timeout = TimeSpan.FromSeconds(4) };

        Text = "地图画 · 桌面控制台";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(960, 650);
        Size = new Size(1250, 850);
        BackColor = Background;
        ForeColor = Ink;
        Font = new Font("Microsoft YaHei UI", 9F);

        var header = new Panel { Dock = DockStyle.Top, Height = 100, BackColor = Color.FromArgb(255, 236, 246), Padding = new Padding(24, 16, 22, 12) };
        header.Paint += (_, e) => { using var brush = new LinearGradientBrush(header.ClientRectangle, Color.FromArgb(255, 228, 241), Color.FromArgb(247, 228, 249), 0F); e.Graphics.FillRectangle(brush, header.ClientRectangle); };
        var heading = new Label { Text = "地图画控制台", Font = new Font(Font.FontFamily, 20F, FontStyle.Bold), ForeColor = Ink, AutoSize = true, Location = new Point(22, 13) };
        _serviceLabel.Text = "正在检查网页服务…";
        _serviceLabel.ForeColor = Sub;
        _serviceLabel.AutoSize = true;
        _serviceLabel.Location = new Point(25, 62);
        header.Controls.Add(heading);
        header.Controls.Add(_serviceLabel);
        var headerButtons = new FlowLayoutPanel { Dock = DockStyle.Right, Width = 665, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Padding = new Padding(0, 12, 0, 0) };
        _openStudio = MakeButton("图片制作", Blue, Color.White, 105);
        _openSites = MakeButton("仓库与领地", Color.FromArgb(229, 99, 159), Color.White, 115);
        _openWeb = MakeButton("建造任务", Violet, Color.White, 105);
        _stopWeb = MakeButton("关闭网页", Pale, Ink, 105);
        _startWeb = MakeButton("启动网页", Pale, Ink, 105);
        headerButtons.Controls.AddRange([_openStudio, _openSites, _openWeb, _stopWeb, _startWeb]);
        header.Controls.Add(headerButtons);

        var logCard = Card();
        logCard.Dock = DockStyle.Bottom;
        logCard.Height = 170;
        logCard.Visible = false;
        logCard.Padding = new Padding(18, 13, 18, 15);
        var logTop = new Panel { Dock = DockStyle.Top, Height = 34 };
        logTop.Controls.Add(new Label { Text = "运行日志", Font = new Font(Font, FontStyle.Bold), AutoSize = true, Location = new Point(0, 4) });
        _followLogs.Text = "跟随最新";
        _followLogs.Checked = true;
        _followLogs.AutoSize = true;
        _followLogs.Dock = DockStyle.Right;
        logTop.Controls.Add(_followLogs);
        _logs.Dock = DockStyle.Fill;
        _logs.ReadOnly = true;
        _logs.BorderStyle = BorderStyle.None;
        _logs.BackColor = Color.FromArgb(255, 248, 252);
        _logs.ForeColor = Ink;
        _logs.Font = new Font("Consolas", 9F);
        _logs.WordWrap = false;
        _logs.DetectUrls = false;
        logCard.Controls.Add(_logs);
        logCard.Controls.Add(logTop);

        var main = new Panel { Dock = DockStyle.Fill, Padding = new Padding(16) };
        var listCard = Card();
        listCard.Dock = DockStyle.Left;
        listCard.Width = 420;
        listCard.Padding = new Padding(17);
        var listTop = new Panel { Dock = DockStyle.Top, Height = 46 };
        listTop.Controls.Add(new Label { Text = "任务列表", Font = new Font(Font.FontFamily, 13F, FontStyle.Bold), AutoSize = true, Location = new Point(0, 5) });
        _refresh = MakeButton("刷新", Pale, Ink, 70);
        _refresh.Dock = DockStyle.Right;
        listTop.Controls.Add(_refresh);
        _jobs.Dock = DockStyle.Fill;
        _jobs.DrawMode = DrawMode.OwnerDrawFixed;
        _jobs.ItemHeight = 62;
        _jobs.IntegralHeight = false;
        _jobs.BorderStyle = BorderStyle.None;
        _jobs.BackColor = Color.FromArgb(255, 253, 254);
        _jobs.DrawItem += DrawJob;
        _jobs.SelectedIndexChanged += (_, _) => UpdateSelection();
        _emptyJobs.Dock = DockStyle.Bottom;
        _emptyJobs.Height = 48;
        _emptyJobs.TextAlign = ContentAlignment.MiddleCenter;
        _emptyJobs.ForeColor = Sub;
        _emptyJobs.Text = "网页未启动。点上方“启动网页”查看任务。";
        listCard.Controls.Add(_jobs);
        listCard.Controls.Add(_emptyJobs);
        listCard.Controls.Add(listTop);

        var actionCard = Card();
        actionCard.Dock = DockStyle.Fill;
        actionCard.Padding = new Padding(22, 20, 22, 16);
        _selectedTitle.Dock = DockStyle.Top;
        _selectedTitle.Height = 37;
        _selectedTitle.Font = new Font(Font.FontFamily, 16F, FontStyle.Bold);
        _selectedTitle.Text = "选择一项任务";
        _selectedMeta.Dock = DockStyle.Top;
        _selectedMeta.Height = 55;
        _selectedMeta.ForeColor = Sub;
        _runState.Dock = DockStyle.Top;
        _runState.Height = 38;
        _runState.ForeColor = Violet;
        _runState.Text = "网页服务未连接";
        var actions = new TableLayoutPanel { Dock = DockStyle.Top, Height = 163, ColumnCount = 2, RowCount = 3, Margin = new Padding(0), Padding = new Padding(0) };
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        for (int i = 0; i < 3; i++) actions.RowStyles.Add(new RowStyle(SizeType.Percent, 33.333F));
        _single = MakeButton("单人建造", Violet, Color.White);
        _dual = MakeButton("双人建造", Blue, Color.White);
        _preflight = MakeButton("开工前检查", Pale, Ink);
        _verify = MakeButton("检查漏铺", Pale, Ink);
        _repair = MakeButton("补齐漏铺", Pale, Ink);
        _stopBot = MakeButton("停止机器人", Color.FromArgb(255, 239, 242), Red);
        Button[] actionButtons = [_single, _dual, _preflight, _verify, _repair, _stopBot];
        for (int i = 0; i < actionButtons.Length; i++) { actionButtons[i].Dock = DockStyle.Fill; actionButtons[i].Margin = new Padding(4); actions.Controls.Add(actionButtons[i], i % 2, i / 2); }
        var tools = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 56, FlowDirection = FlowDirection.LeftToRight, Padding = new Padding(0, 8, 0, 0) };
        _selfCheck = MakeButton("检查程序", Pale, Ink, 105);
        _leftLogin = MakeButton("授权左机器人", Pale, Ink, 120);
        var folder = MakeButton("打开文件夹", Pale, Ink, 105);
        _tooltips.SetToolTip(_selfCheck, "只检查本机程序文件，不会登录游戏。");
        _tooltips.SetToolTip(_leftLogin, "首次使用双人建造时，登录左机器人的微软账号。");
        tools.Controls.AddRange([_selfCheck, _leftLogin, folder]);
        var note = new Label { Dock = DockStyle.Fill, ForeColor = Sub, Text = "要加新任务、修改建造落点，请打开网页。仓库和领地名称在“场地坐标”里。这里不会自己开工。", Padding = new Padding(0, 10, 0, 0) };
        actionCard.Controls.Add(note);
        actionCard.Controls.Add(tools);
        actionCard.Controls.Add(actions);
        actionCard.Controls.Add(_runState);
        actionCard.Controls.Add(_selectedMeta);
        actionCard.Controls.Add(_selectedTitle);

        var gap = new Panel { Dock = DockStyle.Left, Width = 14 };
        main.Controls.Add(actionCard);
        main.Controls.Add(gap);
        main.Controls.Add(listCard);
        var toolsBar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 52, BackColor = Color.FromArgb(255, 242, 249), Padding = new Padding(17, 5, 0, 0), WrapContents = false };
        _refresh.Text = "刷新页面";
        _refresh.Width = 95;
        _refresh.Dock = DockStyle.None;
        toolsBar.Controls.Add(_refresh);
        toolsBar.Controls.Add(_selfCheck);
        toolsBar.Controls.Add(_leftLogin);
        var external = MakeButton("浏览器打开", Pale, Ink, 110);
        toolsBar.Controls.Add(external);
        var toggleLogs = MakeButton("工具记录", Pale, Ink, 95);
        toolsBar.Controls.Add(toggleLogs);
        external.Click += (_, _) => OpenExternalUrl();
        toggleLogs.Click += (_, _) => { logCard.Visible = !logCard.Visible; toggleLogs.Text = logCard.Visible ? "收起记录" : "工具记录"; };

        var webHost = new Panel { Dock = DockStyle.Fill, BackColor = Background, Padding = new Padding(12, 10, 12, 10) };
        _webView.Dock = DockStyle.Fill;
        _webView.Visible = false;
        _offlineMessage.Dock = DockStyle.Fill;
        _offlineMessage.TextAlign = ContentAlignment.MiddleCenter;
        _offlineMessage.Font = new Font(Font.FontFamily, 13F);
        _offlineMessage.ForeColor = Sub;
        _offlineMessage.Text = "正在连接地图画控制台…";
        webHost.Controls.Add(_webView);
        webHost.Controls.Add(_offlineMessage);
        Controls.Add(webHost);
        Controls.Add(logCard);
        Controls.Add(toolsBar);
        Controls.Add(header);

        _startWeb.Click += async (_, _) => await StartWebAsync();
        _stopWeb.Click += async (_, _) => await StopWebAsync();
        _openWeb.Click += async (_, _) => await NavigateAsync("/");
        _openStudio.Click += async (_, _) => await NavigateAsync("/studio");
        _openSites.Click += async (_, _) => await NavigateAsync("/sites");
        _refresh.Click += async (_, _) => { await RefreshAsync(); if (_webInitialized && _serviceOnline) _webView.Reload(); };
        _single.Click += async (_, _) => await StartJobAsync("single");
        _dual.Click += async (_, _) => await StartJobAsync("dual");
        _preflight.Click += async (_, _) => await PreflightAsync(true);
        _verify.Click += async (_, _) => await RunJobCommandAsync("verify", "检查所选地图画有没有漏铺？只检查，不会放置方块。");
        _repair.Click += async (_, _) => await RunJobCommandAsync("repair", "机器人会尝试补齐漏铺。此功能尚未在真实服务器完整验证，请先确认地图画和建造位置。\n\n确定继续吗？");
        _stopBot.Click += async (_, _) => await StopBotAsync();
        _selfCheck.Click += async (_, _) => await RunLocalToolAsync("check");
        _leftLogin.Click += async (_, _) => await RunLocalToolAsync("login-left");
        folder.Click += (_, _) => Process.Start(new ProcessStartInfo(_root) { UseShellExecute = true });
        _timer.Tick += async (_, _) => await RefreshAsync();
        Shown += async (_, _) => { await RefreshAsync(); _timer.Start(); };
        FormClosing += OnFormClosing;
        UpdateButtons();
    }

    private static GraphicsPath RoundedPath(Rectangle rectangle, int radius)
    {
        var path = new GraphicsPath();
        int diameter = radius * 2;
        path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
        path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
        path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static void Round(Control control, int radius)
    {
        if (control.Width < radius * 2 || control.Height < radius * 2) return;
        using var path = RoundedPath(new Rectangle(0, 0, control.Width, control.Height), radius);
        var old = control.Region;
        control.Region = new Region(path);
        old?.Dispose();
    }

    private static Panel Card()
    {
        var card = new Panel { BackColor = Color.White };
        card.Resize += (_, _) => Round(card, 15);
        return card;
    }

    private static Button MakeButton(string text, Color background, Color foreground, int width = 120)
    {
        var button = new Button { Text = text, Width = width, Height = 36, Margin = new Padding(4), BackColor = background, ForeColor = foreground, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand, Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold) };
        button.FlatAppearance.BorderSize = 0;
        button.Resize += (_, _) => Round(button, 8);
        Round(button, 8);
        return button;
    }

    private static string FindProjectRoot()
    {
        DirectoryInfo? dir = new(AppContext.BaseDirectory);
        for (int i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "dashboard.js")) && File.Exists(Path.Combine(dir.FullName, "painting_v2.js"))) return dir.FullName;
        throw new InvalidOperationException("请把“地图画控制台.exe”放在“地图画”文件夹内，或从项目内的发布目录运行。");
    }

    private static string? FindOnPath(string name)
    {
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            try { string file = Path.Combine(directory.Trim('"'), name); if (File.Exists(file)) return file; }
            catch { /* Ignore malformed PATH entries. */ }
        }
        return null;
    }

    private static string TextOf(JsonElement element, string property, string fallback = "") =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value) ? value.ToString() : fallback;

    private static int IntOf(JsonElement element, string property) => int.TryParse(TextOf(element, property), out int value) ? value : 0;

    private static double DoubleOf(JsonElement element, string property) => double.TryParse(TextOf(element, property), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double value) ? value : 0;

    private static bool BoolOf(JsonElement element, string property) => bool.TryParse(TextOf(element, property), out bool value) && value;

    private async Task<bool> PingDashboardAsync()
    {
        try
        {
            using var response = await _http.GetAsync("/studio");
            return response.IsSuccessStatusCode && (await response.Content.ReadAsStringAsync()).Contains("地图画工作台", StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private async Task<JsonDocument> GetApiAsync(string path)
    {
        using var response = await _http.GetAsync(path);
        string body = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(ApiError(body, response.StatusCode.ToString()));
        return JsonDocument.Parse(body);
    }

    private async Task PostApiAsync(string path, object? body = null)
    {
        using var response = await _http.PostAsJsonAsync(path, body ?? new { });
        string result = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(ApiError(result, response.StatusCode.ToString()));
    }

    private static string ApiError(string body, string fallback)
    {
        try { using var parsed = JsonDocument.Parse(body); return TextOf(parsed.RootElement, "error", fallback); }
        catch { return fallback; }
    }

    private async Task RefreshAsync()
    {
        if (_refreshing || IsDisposed) return;
        _refreshing = true;
        try
        {
            _serviceOnline = await PingDashboardAsync();
            if (!_serviceOnline)
            {
                _botRunning = false;
                _serverLogs = "";
                _jobs.Items.Clear();
                UpdateSelection();
                _runState.Text = "网页服务未启动";
                _serviceLabel.Text = $"● 网页未启动 · 本机端口 {_port}";
                _serviceLabel.ForeColor = Sub;
            }
            else
            {
                using var status = await GetApiAsync("/api/status");
                JsonElement data = status.RootElement;
                _botRunning = BoolOf(data, "running");
                _serviceLabel.Text = _dashboardProcess is { HasExited: false } ? $"● 网页运行中 · 本程序管理 · {_baseUrl}" : $"● 网页运行中 · 由其他窗口启动 · {_baseUrl}";
                _serviceLabel.ForeColor = Color.FromArgb(30, 139, 103);
                _runState.Text = _botRunning ? "机器人正在运行 · 可查看日志或停止" : "机器人空闲 · 请选择任务";
                if (data.TryGetProperty("lastRun", out var run) && TextOf(run, "state") is "completed" or "failed" or "stopped")
                    _runState.Text += $"  |  上次：{TextOf(run, "jobName")} · {TextOf(run, "state")}";
                RenderJobs(data.GetProperty("jobs"));
                _serverLogs = data.TryGetProperty("logs", out var lines) && lines.ValueKind == JsonValueKind.Array
                    ? string.Join(Environment.NewLine, lines.EnumerateArray().Select(item => item.ToString())) : "";
            }
            RenderLogs();
            UpdateButtons();
            await SyncBrowserAsync();
        }
        catch (Exception error)
        {
            _serviceOnline = false;
            _botRunning = false;
            _jobs.Items.Clear();
            UpdateSelection();
            _serviceLabel.Text = "● 网页响应异常：" + error.Message;
            _serviceLabel.ForeColor = Red;
            AppendLocalLog("状态读取失败：" + error.Message);
            UpdateButtons();
            await SyncBrowserAsync();
        }
        finally { _refreshing = false; }
    }

    private void RenderJobs(JsonElement jobs)
    {
        string? selectedId = SelectedJob?.Id;
        var items = new List<JobInfo>();
        foreach (var job in jobs.EnumerateArray())
        {
            var origin = job.GetProperty("origin");
            var progress = job.TryGetProperty("progress", out var p) ? p : default;
            items.Add(new JobInfo
            {
                Id = TextOf(job, "id"), Name = TextOf(job, "name"), Schematic = TextOf(job, "schematicPath"),
                Position = $"{TextOf(origin, "x")}, {TextOf(origin, "y")}, {TextOf(origin, "z")}",
                Done = IntOf(progress, "done"), Total = IntOf(progress, "totalRows"), Percent = DoubleOf(progress, "percent")
            });
        }
        if (_jobs.Items.Count == items.Count && items.Select(item => item.Id).SequenceEqual(_jobs.Items.Cast<JobInfo>().Select(item => item.Id)))
        {
            for (int i = 0; i < items.Count; i++)
            {
                var old = (JobInfo)_jobs.Items[i]!;
                var next = items[i];
                if (old.Name != next.Name || old.Position != next.Position || old.Done != next.Done || old.Total != next.Total || old.Percent != next.Percent)
                    _jobs.Items[i] = next;
            }
            UpdateSelection();
            return;
        }
        int oldTop = _jobs.TopIndex;
        _jobs.BeginUpdate();
        _jobs.Items.Clear();
        foreach (var item in items) _jobs.Items.Add(item);
        if (items.Count > 0) _jobs.SelectedIndex = Math.Max(0, items.FindIndex(item => item.Id == selectedId));
        if (items.Count > 0) _jobs.TopIndex = Math.Min(oldTop, items.Count - 1);
        _jobs.EndUpdate();
        UpdateSelection();
    }

    private void DrawJob(object? sender, DrawItemEventArgs e)
    {
        if (e.Index < 0 || _jobs.Items[e.Index] is not JobInfo job) return;
        bool selected = (e.State & DrawItemState.Selected) != 0;
        using var background = new SolidBrush(selected ? Color.FromArgb(255, 228, 242) : Color.White);
        e.Graphics.FillRectangle(background, e.Bounds);
        int x = e.Bounds.Left + 10;
        using var bold = new Font(Font, FontStyle.Bold);
        TextRenderer.DrawText(e.Graphics, job.Name, bold, new Rectangle(x, e.Bounds.Top + 5, e.Bounds.Width - 90, 25), Ink, TextFormatFlags.EndEllipsis);
        TextRenderer.DrawText(e.Graphics, $"{job.Position}  ·  {job.Done}/{job.Total} 行", Font, new Rectangle(x, e.Bounds.Top + 31, e.Bounds.Width - 22, 23), Sub, TextFormatFlags.EndEllipsis);
        TextRenderer.DrawText(e.Graphics, $"{job.Percent:0.#}%", Font, new Rectangle(e.Bounds.Right - 60, e.Bounds.Top + 7, 45, 22), Violet, TextFormatFlags.Right);
        using var line = new Pen(Color.FromArgb(238, 241, 247));
        e.Graphics.DrawLine(line, e.Bounds.Left, e.Bounds.Bottom - 1, e.Bounds.Right, e.Bounds.Bottom - 1);
        e.DrawFocusRectangle();
    }

    private JobInfo? SelectedJob => _jobs.SelectedItem as JobInfo;

    private void UpdateSelection()
    {
        var job = SelectedJob;
        _emptyJobs.Visible = _jobs.Items.Count == 0;
        _emptyJobs.Text = _serviceOnline ? "暂无任务。请在主网页创建地图画任务。" : "网页未启动。点上方“启动网页”查看任务。";
        _selectedTitle.Text = job?.Name ?? "选择一项任务";
        _selectedMeta.Text = job is null ? "在左侧选择要铺设或复检的地图画。" : $"{job.Schematic}\n起点 {job.Position} · 已记录 {job.Done}/{job.Total} 行";
        UpdateButtons();
    }

    private void UpdateButtons()
    {
        bool ownsWeb = _dashboardProcess is { HasExited: false };
        bool hasJob = SelectedJob != null;
        _startWeb.Enabled = !_serviceOnline && !_startingWeb;
        _stopWeb.Enabled = _serviceOnline && ownsWeb;
        _openWeb.Enabled = _serviceOnline;
        _openStudio.Enabled = _serviceOnline;
        _openSites.Enabled = _serviceOnline;
        _refresh.Enabled = true;
        _single.Enabled = _dual.Enabled = _preflight.Enabled = _verify.Enabled = _repair.Enabled = _serviceOnline && hasJob && !_botRunning;
        _stopBot.Enabled = _serviceOnline && _botRunning;
        _leftLogin.Enabled = !_botRunning && _toolProcess == null;
        _selfCheck.Enabled = !_botRunning && _toolProcess == null;
    }

    private void RenderLogs()
    {
        string value = string.Join(Environment.NewLine, _localLogs.TakeLast(70));
        if (value.Length > 0 && _serverLogs.Length > 0) value += Environment.NewLine + "──────────────────── 网页 / 机器人 ────────────────────" + Environment.NewLine;
        value += _serverLogs;
        if (value == _shownLogs) return;
        _shownLogs = value;
        int oldStart = _logs.SelectionStart, oldLength = _logs.SelectionLength;
        _logs.Text = value;
        if (_followLogs.Checked && oldLength == 0) { _logs.SelectionStart = _logs.TextLength; _logs.ScrollToCaret(); }
        else { _logs.SelectionStart = Math.Min(oldStart, _logs.TextLength); _logs.SelectionLength = Math.Min(oldLength, _logs.TextLength - _logs.SelectionStart); }
    }

    private void AppendLocalLog(string message)
    {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(() => AppendLocalLog(message)); return; }
        _localLogs.Add($"[{DateTime.Now:HH:mm:ss}] {message}");
        if (_localLogs.Count > 100) _localLogs.RemoveAt(0);
        RenderLogs();
    }

    private void ShowError(string operation, Exception error)
    {
        AppendLocalLog($"{operation}失败：{error.Message}");
        MessageBox.Show(this, error.Message, operation + "失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private async Task StartWebAsync()
    {
        if (_startingWeb) return;
        _startingWeb = true;
        UpdateButtons();
        try
        {
            if (await PingDashboardAsync()) { await RefreshAsync(); MessageBox.Show(this, "网页服务已在运行，已连接现有实例。", "网页已运行"); return; }
            var start = new ProcessStartInfo(_node) { WorkingDirectory = _root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            start.ArgumentList.Add("dashboard.js");
            _dashboardProcess = Process.Start(start) ?? throw new InvalidOperationException("无法启动 dashboard.js");
            _dashboardProcess.OutputDataReceived += (_, e) => { if (!string.IsNullOrEmpty(e.Data)) AppendLocalLog(e.Data); };
            _dashboardProcess.ErrorDataReceived += (_, e) => { if (!string.IsNullOrEmpty(e.Data)) AppendLocalLog(e.Data); };
            _dashboardProcess.BeginOutputReadLine();
            _dashboardProcess.BeginErrorReadLine();
            AppendLocalLog("正在启动网页服务…");
            for (int i = 0; i < 35; i++)
            {
                if (await PingDashboardAsync()) { await RefreshAsync(); return; }
                if (_dashboardProcess.HasExited) break;
                await Task.Delay(200);
            }
            throw new InvalidOperationException("网页未在预期端口启动。请检查下方日志，或确认端口是否被占用。");
        }
        catch (Exception error) { ShowError("启动网页", error); await RefreshAsync(); }
        finally { _startingWeb = false; UpdateButtons(); }
    }

    private async Task<bool> StopWebAsync()
    {
        if (_dashboardProcess is not { HasExited: false })
        {
            MessageBox.Show(this, "这个网页服务不是由本程序启动的。为避免误关别的控制台，请到原窗口关闭它。", "无法代关", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return false;
        }
        try
        {
            if (!await PingDashboardAsync()) throw new InvalidOperationException("无法确认网页服务当前状态；为防止遗留机器人，不会直接结束进程。");
            using (var status = await GetApiAsync("/api/status"))
            {
                if (BoolOf(status.RootElement, "running"))
                {
                    if (MessageBox.Show(this, "机器人仍在运行。先请求停止机器人，再关闭网页服务？未完成区域下次会重新检查。", "确认关闭", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return false;
                    await PostApiAsync("/api/stop");
                    if (!await WaitForIdleAsync("/api/status")) throw new InvalidOperationException("机器人尚未确认停止，网页服务保持运行。请查看日志。");
                }
            }
            using (var progress = await GetApiAsync("/api/studio/progress"))
            {
                if (BoolOf(progress.RootElement, "running"))
                {
                    if (MessageBox.Show(this, "图片转换仍在进行。先安全取消转换，再关闭网页？", "确认关闭", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return false;
                    await PostApiAsync("/api/studio/cancel");
                    if (!await WaitForIdleAsync("/api/studio/progress")) throw new InvalidOperationException("图片转换尚未确认停止，网页服务保持运行。");
                }
            }
            _dashboardProcess.Kill();
            await _dashboardProcess.WaitForExitAsync();
            _dashboardProcess.Dispose();
            _dashboardProcess = null;
            AppendLocalLog("已关闭本程序启动的网页服务。") ;
            await RefreshAsync();
            return true;
        }
        catch (Exception error) { ShowError("关闭网页", error); return false; }
    }

    private async Task<bool> WaitForIdleAsync(string path)
    {
        for (int i = 0; i < 40; i++)
        {
            await Task.Delay(250);
            using var response = await GetApiAsync(path);
            if (!BoolOf(response.RootElement, "running")) return true;
        }
        return false;
    }

    private async Task SyncBrowserAsync()
    {
        if (!_serviceOnline)
        {
            _webWasOnline = false;
            _webView.Visible = false;
            _offlineMessage.Visible = true;
            _offlineMessage.Text = "网页服务未启动。点击上方“启动网页”后，就能在这里管理全部任务和设置。";
            return;
        }
        if (_webInitializing) return;
        if (!_webInitialized)
        {
            _webInitializing = true;
            try
            {
                string dataFolder = Path.Combine(_root, "state", "desktop-webview");
                Directory.CreateDirectory(dataFolder);
                // Give WebView2 a visible control handle; the offline label stays above it until navigation is ready.
                _webView.Visible = true;
                var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: dataFolder);
                await _webView.EnsureCoreWebView2Async(environment);
                _webView.CoreWebView2.NavigationCompleted += (_, e) =>
                {
                    if (!e.IsSuccess || _webView.Source is not Uri uri || uri.Authority != $"127.0.0.1:{_port}") return;
                    _requestedPath = uri.PathAndQuery;
                };
                _webInitialized = true;
                _webView.Source = new Uri(_baseUrl + _requestedPath);
            }
            catch (Exception error)
            {
                _webView.Visible = false;
                _offlineMessage.Text = "无法打开内嵌页面：" + error.Message + "\n可点“浏览器打开”继续使用。";
                AppendLocalLog("内嵌页面启动失败：" + error.Message);
                return;
            }
            finally { _webInitializing = false; }
        }
        else if (!_webWasOnline) _webView.Source = new Uri(_baseUrl + _requestedPath);
        _webWasOnline = true;
        _offlineMessage.Visible = false;
        _webView.Visible = true;
    }

    private async Task NavigateAsync(string path)
    {
        _requestedPath = path;
        if (!_serviceOnline) return;
        await SyncBrowserAsync();
        if (_webInitialized && _webView.Source?.PathAndQuery != path) _webView.Source = new Uri(_baseUrl + path);
    }

    private void OpenExternalUrl()
    {
        if (!_serviceOnline) return;
        try { Process.Start(new ProcessStartInfo(_baseUrl + _requestedPath) { UseShellExecute = true }); }
        catch (Exception error) { ShowError("打开浏览器", error); }
    }

    private async Task<bool> PreflightAsync(bool showDialog)
    {
        var job = SelectedJob;
        if (job == null) return false;
        try
        {
            using var result = await GetApiAsync("/api/preflight/" + Uri.EscapeDataString(job.Id));
            var root = result.RootElement;
            bool passed = BoolOf(root, "passed");
            var checks = root.GetProperty("checks").EnumerateArray().Select(item => $"{(TextOf(item, "level") == "error" ? "✕" : "•")} {TextOf(item, "text")}").ToArray();
            if (showDialog || !passed) MessageBox.Show(this, string.Join(Environment.NewLine, checks), passed ? "开始前检查通过" : "开始前检查未通过", MessageBoxButtons.OK, passed ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            return passed;
        }
        catch (Exception error) { ShowError("开始前检查", error); return false; }
    }

    private async Task StartJobAsync(string mode)
    {
        var job = SelectedJob;
        if (job == null || _botRunning) return;
        if (!await PreflightAsync(false)) return;
        string text = mode == "dual" ? $"双人铺设“{job.Name}”？右机器人先铺完整平滑石头，再由左右两个账号同时铺地毯。" : $"单人铺设“{job.Name}”？请确认地图位置 {job.Position} 正确。";
        if (MessageBox.Show(this, text, "确认开始", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        try { await PostApiAsync("/api/start/" + Uri.EscapeDataString(job.Id), new { buildMode = mode }); AppendLocalLog($"已提交：{job.Name} · {mode}"); await RefreshAsync(); }
        catch (Exception error) { ShowError("开始铺设", error); }
    }

    private async Task RunJobCommandAsync(string mode, string confirmation)
    {
        var job = SelectedJob;
        if (job == null || _botRunning) return;
        if (MessageBox.Show(this, $"任务：{job.Name}\n起点：{job.Position}\n\n{confirmation}", "确认操作", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        try { await PostApiAsync($"/api/{mode}/" + Uri.EscapeDataString(job.Id)); AppendLocalLog($"已提交：{job.Name} · {mode}"); await RefreshAsync(); }
        catch (Exception error) { ShowError(mode == "repair" ? "修复" : "复检", error); }
    }

    private async Task StopBotAsync()
    {
        if (!_botRunning || MessageBox.Show(this, "终止当前机器人？未完成区域下次会重新检查。", "确认停止", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        try { await PostApiAsync("/api/stop"); AppendLocalLog("已请求停止机器人。"); await RefreshAsync(); }
        catch (Exception error) { ShowError("停止机器人", error); }
    }

    private async Task RunLocalToolAsync(string tool)
    {
        if (_toolProcess != null) return;
        if (tool == "login-left" && _botRunning) { MessageBox.Show(this, "请先停止机器人，再授权左账号。", "暂不可用"); return; }
        if (tool == "login-left" && MessageBox.Show(this, "左账号授权会连接服务器，并可能显示微软设备登录提示。请确认当前没有其他机器人使用左账号。", "确认授权", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        try
        {
            var start = tool == "login-left" ? new ProcessStartInfo(_node) : new ProcessStartInfo("cmd.exe");
            start.WorkingDirectory = _root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.StandardErrorEncoding = Encoding.UTF8;
            if (tool == "login-left") start.ArgumentList.Add("login_left_account.js");
            else { start.ArgumentList.Add("/d"); start.ArgumentList.Add("/c"); start.ArgumentList.Add("npm.cmd run check"); }
            _toolProcess = Process.Start(start) ?? throw new InvalidOperationException("无法启动工具");
            _toolProcess.OutputDataReceived += (_, e) => { if (!string.IsNullOrEmpty(e.Data)) AppendLocalLog(e.Data); };
            _toolProcess.ErrorDataReceived += (_, e) => { if (!string.IsNullOrEmpty(e.Data)) AppendLocalLog(e.Data); };
            _toolProcess.BeginOutputReadLine();
            _toolProcess.BeginErrorReadLine();
            AppendLocalLog($"已启动：{(tool == "login-left" ? "授权左机器人" : "检查程序")}");
            UpdateButtons();
            await _toolProcess.WaitForExitAsync();
            AppendLocalLog($"工具已结束，代码 {_toolProcess.ExitCode}");
            _toolProcess.Dispose();
            _toolProcess = null;
            UpdateButtons();
        }
        catch (Exception error) { ShowError("辅助工具", error); _toolProcess = null; UpdateButtons(); }
    }

    private async void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_closingApproved) return;
        if (_toolProcess is { HasExited: false })
        {
            e.Cancel = true;
            MessageBox.Show(this, "辅助工具仍在运行，请等待它结束后再关闭窗口。", "暂不能退出", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        if (_dashboardProcess is not { HasExited: false }) return;
        e.Cancel = true;
        _timer.Stop();
        if (await StopWebAsync()) { _closingApproved = true; Close(); }
        else _timer.Start();
    }
}
