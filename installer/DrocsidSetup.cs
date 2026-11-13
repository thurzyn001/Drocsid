using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Instalador do Drocsid")]
[assembly: AssemblyDescription("Instalador oficial do Drocsid - Chat, Voz & Compartilhamento de Tela")]
[assembly: AssemblyProduct("Drocsid")]
[assembly: AssemblyVersion("0.3.0.0")]

namespace DrocsidInstaller
{
    public class SetupForm : Form
    {
        private TextBox txtInstallDir;
        private CheckBox chkDesktopShortcut;
        private CheckBox chkStartMenuShortcut;
        private CheckBox chkLaunchAfter;
        private ProgressBar progressBar;
        private Label lblStatus;
        private Button btnInstall;
        private Button btnCancel;

        public SetupForm()
        {
            this.Text = "Instalador do Drocsid v0.3.0";
            this.Size = new Size(520, 390);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(43, 45, 49);
            this.ForeColor = Color.FromArgb(242, 243, 245);
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            Panel headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 76,
                BackColor = Color.FromArgb(30, 31, 34),
                Padding = new Padding(20, 14, 20, 14)
            };

            Label lblTitle = new Label
            {
                Text = "Drocsid — Chat, Voz & Go Live (Rust)",
                Font = new Font("Segoe UI", 14f, FontStyle.Bold),
                ForeColor = Color.White,
                AutoSize = true,
                Location = new Point(20, 14)
            };

            Label lblSub = new Label
            {
                Text = "Compartilhamento de tela até 60 FPS + Conexão direta na Internet com amigos",
                Font = new Font("Segoe UI", 9f, FontStyle.Regular),
                ForeColor = Color.FromArgb(165, 180, 252),
                AutoSize = true,
                Location = new Point(20, 44)
            };

            headerPanel.Controls.Add(lblTitle);
            headerPanel.Controls.Add(lblSub);
            this.Controls.Add(headerPanel);

            Label lblDir = new Label
            {
                Text = "Pasta de instalação:",
                Location = new Point(22, 92),
                AutoSize = true,
                ForeColor = Color.FromArgb(219, 222, 225)
            };
            this.Controls.Add(lblDir);

            string defaultDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "Drocsid"
            );

            txtInstallDir = new TextBox
            {
                Text = defaultDir,
                Location = new Point(22, 115),
                Width = 370,
                BackColor = Color.FromArgb(30, 31, 34),
                ForeColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle
            };
            this.Controls.Add(txtInstallDir);

            Button btnBrowse = new Button
            {
                Text = "Procurar...",
                Location = new Point(400, 113),
                Width = 86,
                Height = 26,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(56, 58, 64),
                ForeColor = Color.White
            };
            btnBrowse.FlatAppearance.BorderSize = 0;
            btnBrowse.Click += (s, e) =>
            {
                using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                {
                    fbd.SelectedPath = txtInstallDir.Text;
                    if (fbd.ShowDialog() == DialogResult.OK)
                    {
                        txtInstallDir.Text = fbd.SelectedPath;
                    }
                }
            };
            this.Controls.Add(btnBrowse);

            chkDesktopShortcut = new CheckBox
            {
                Text = "Criar atalho na Área de Trabalho (Desktop)",
                Checked = true,
                Location = new Point(22, 155),
                AutoSize = true
            };
            this.Controls.Add(chkDesktopShortcut);

            chkStartMenuShortcut = new CheckBox
            {
                Text = "Criar atalho no Menu Iniciar do Windows",
                Checked = true,
                Location = new Point(22, 183),
                AutoSize = true
            };
            this.Controls.Add(chkStartMenuShortcut);

            chkLaunchAfter = new CheckBox
            {
                Text = "Iniciar o Drocsid automaticamente ao concluir",
                Checked = true,
                Location = new Point(22, 211),
                AutoSize = true
            };
            this.Controls.Add(chkLaunchAfter);

            lblStatus = new Label
            {
                Text = "Pronto para instalar.",
                Location = new Point(22, 248),
                AutoSize = true,
                ForeColor = Color.FromArgb(148, 155, 164)
            };
            this.Controls.Add(lblStatus);

            progressBar = new ProgressBar
            {
                Location = new Point(22, 272),
                Width = 464,
                Height = 18,
                Minimum = 0,
                Maximum = 100,
                Value = 0
            };
            this.Controls.Add(progressBar);

            btnInstall = new Button
            {
                Text = "Instalar Agora",
                Location = new Point(346, 306),
                Width = 140,
                Height = 34,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(88, 101, 242),
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold)
            };
            btnInstall.FlatAppearance.BorderSize = 0;
            btnInstall.Click += OnInstallClick;
            this.Controls.Add(btnInstall);

            btnCancel = new Button
            {
                Text = "Cancelar",
                Location = new Point(242, 306),
                Width = 94,
                Height = 34,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(56, 58, 64),
                ForeColor = Color.White
            };
            btnCancel.FlatAppearance.BorderSize = 0;
            btnCancel.Click += (s, e) => this.Close();
            this.Controls.Add(btnCancel);
        }

        private void OnInstallClick(object sender, EventArgs e)
        {
            btnInstall.Enabled = false;
            btnCancel.Enabled = false;

            try
            {
                string targetDir = txtInstallDir.Text.Trim();
                lblStatus.Text = "Criando diretório de instalação...";
                progressBar.Value = 15;
                Application.DoEvents();

                Directory.CreateDirectory(targetDir);

                // Encerra instância anterior caso esteja aberta durante atualização
                foreach (var proc in Process.GetProcessesByName("drocsid"))
                {
                    try { proc.Kill(); proc.WaitForExit(1500); } catch { }
                }

                string exePath = Path.Combine(targetDir, "drocsid.exe");
                lblStatus.Text = "Extraindo binário nativo drocsid.exe...";
                progressBar.Value = 45;
                Application.DoEvents();

                using (Stream resStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Drocsid.exe.gz"))
                {
                    if (resStream == null)
                    {
                        throw new Exception("Recurso embutido 'Drocsid.exe.gz' não encontrado no instalador.");
                    }
                    using (GZipStream gz = new GZipStream(resStream, CompressionMode.Decompress))
                    using (FileStream fs = new FileStream(exePath, FileMode.Create, FileAccess.Write))
                    {
                        gz.CopyTo(fs);
                    }
                }

                // Copia o próprio instalador para suportar desinstalação via Painel de Controle
                string uninstallerPath = Path.Combine(targetDir, "Uninstall-Drocsid.exe");
                try
                {
                    File.Copy(Application.ExecutablePath, uninstallerPath, true);
                }
                catch { }

                // Extrai o ícone nativo para os atalhos e registro
                string iconPath = Path.Combine(targetDir, "drocsid.ico");
                try
                {
                    using (Stream icoStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Drocsid.ico"))
                    {
                        if (icoStream != null)
                        {
                            using (FileStream fs = new FileStream(iconPath, FileMode.Create, FileAccess.Write))
                            {
                                icoStream.CopyTo(fs);
                            }
                        }
                    }
                }
                catch { }
                string shortcutIcon = File.Exists(iconPath) ? iconPath : exePath;

                lblStatus.Text = "Criando atalhos do sistema...";
                progressBar.Value = 75;
                Application.DoEvents();

                if (chkDesktopShortcut.Checked)
                {
                    string desktopLink = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                        "Drocsid.lnk"
                    );
                    CreateShortcut(desktopLink, exePath, targetDir, "Drocsid — Chat, Voz e Compartilhamento de Tela", shortcutIcon);
                }

                if (chkStartMenuShortcut.Checked)
                {
                    string startMenuDir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                        "Drocsid"
                    );
                    Directory.CreateDirectory(startMenuDir);
                    string startLink = Path.Combine(startMenuDir, "Drocsid.lnk");
                    CreateShortcut(startLink, exePath, targetDir, "Drocsid — Chat, Voz e Compartilhamento de Tela", shortcutIcon);
                }

                RegisterUninstaller(targetDir, shortcutIcon, uninstallerPath);

                progressBar.Value = 100;
                lblStatus.Text = "Instalação concluída com sucesso!";
                lblStatus.ForeColor = Color.FromArgb(134, 239, 172);
                Application.DoEvents();

                if (chkLaunchAfter.Checked)
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = exePath,
                        WorkingDirectory = targetDir,
                        UseShellExecute = true
                    });
                }

                MessageBox.Show(
                    "O Drocsid foi instalado com sucesso!\n\n" +
                    "• Use o botão '📡 Gerar Convite' dentro do app para criar um link/código e jogar com amigos de outras redes sem precisar de VPN.\n" +
                    "• Envie este mesmo instalador (Drocsid-Setup.exe) para seus amigos instalarem!",
                    "Drocsid Instalado",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );

                this.Close();
            }
            catch (Exception ex)
            {
                btnInstall.Enabled = true;
                btnCancel.Enabled = true;
                lblStatus.Text = "Erro na instalação.";
                MessageBox.Show("Erro durante a instalação:\n" + ex.Message, "Erro", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void CreateShortcut(string shortcutPath, string targetExe, string workDir, string description, string iconPath)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
            Type scType = shortcut.GetType();
            scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetExe });
            scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workDir });
            scType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { description });
            if (!string.IsNullOrEmpty(iconPath))
            {
                scType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { iconPath });
            }
            scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }

        private static void RegisterUninstaller(string installDir, string exePath, string uninstallerPath)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Drocsid"))
                {
                    if (key != null)
                    {
                        key.SetValue("DisplayName", "Drocsid — Chat, Voz & Go Live");
                        key.SetValue("DisplayVersion", "0.3.0");
                        key.SetValue("Publisher", "Drocsid Open Project");
                        key.SetValue("DisplayIcon", exePath);
                        key.SetValue("InstallLocation", installDir);
                        key.SetValue("UninstallString", "\"" + uninstallerPath + "\" --uninstall");
                        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    }
                }
            }
            catch { }

            try
            {
                using (RegistryKey proto = Registry.CurrentUser.CreateSubKey(@"Software\Classes\drocsid"))
                {
                    if (proto != null)
                    {
                        proto.SetValue("", "URL:Drocsid Invite Protocol");
                        proto.SetValue("URL Protocol", "");
                        using (RegistryKey iconKey = proto.CreateSubKey("DefaultIcon"))
                        {
                            if (iconKey != null) iconKey.SetValue("", "\"" + exePath + "\",0");
                        }
                        using (RegistryKey cmdKey = proto.CreateSubKey(@"shell\open\command"))
                        {
                            if (cmdKey != null) cmdKey.SetValue("", "\"" + exePath + "\" \"%1\"");
                        }
                    }
                }
            }
            catch { }
        }

        public static void RunUninstall()
        {
            var confirm = MessageBox.Show(
                "Deseja desinstalar o Drocsid do seu computador?",
                "Desinstalar Drocsid",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (confirm != DialogResult.Yes) return;

            var purgeData = MessageBox.Show(
                "Deseja apagar também seu histórico de chat, logs e perfil do navegador salvos?",
                "Manter ou apagar dados",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );

            foreach (var proc in Process.GetProcessesByName("drocsid"))
            {
                try { proc.Kill(); proc.WaitForExit(1500); } catch { }
            }

            string desktopLink = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                "Drocsid.lnk"
            );
            if (File.Exists(desktopLink)) try { File.Delete(desktopLink); } catch { }

            string startMenuDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                "Drocsid"
            );
            if (Directory.Exists(startMenuDir)) try { Directory.Delete(startMenuDir, true); } catch { }

            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Drocsid", false);
            }
            catch { }

            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\drocsid", false);
            }
            catch { }

            string installDir = Path.GetDirectoryName(Application.ExecutablePath);
            string uninstallerExe = installDir != null ? Path.Combine(installDir, "Uninstall-Drocsid.exe") : null;
            if (!string.IsNullOrEmpty(installDir)
                && Directory.Exists(installDir)
                && File.Exists(uninstallerExe))
            {
                try
                {
                    if (purgeData == DialogResult.Yes)
                    {
                        var psi = new ProcessStartInfo("cmd.exe", "/C timeout /t 2 /nobreak >nul & rmdir /s /q \"" + installDir + "\"")
                        {
                            CreateNoWindow = true,
                            UseShellExecute = false
                        };
                        Process.Start(psi);
                    }
                    else
                    {
                        foreach (string fname in new[] { "drocsid.exe", "drocsid.ico", "cloudflared.exe", "session.url" })
                        {
                            string p = Path.Combine(installDir, fname);
                            if (File.Exists(p)) try { File.Delete(p); } catch { }
                        }
                        var psi = new ProcessStartInfo("cmd.exe", "/C timeout /t 2 /nobreak >nul & del /f /q \"" + uninstallerExe + "\"")
                        {
                            CreateNoWindow = true,
                            UseShellExecute = false
                        };
                        Process.Start(psi);
                    }
                }
                catch { }
            }

            MessageBox.Show("O Drocsid foi removido com sucesso.", "Desinstalado", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        [STAThread]
        public static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args != null && args.Length > 0 && args[0] == "--uninstall")
            {
                RunUninstall();
                return;
            }

            Application.Run(new SetupForm());
        }
    }
}
