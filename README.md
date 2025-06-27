# Jujutsu Kaizen

![banner](images/banner.png)

> A Visual Studio Code extension for the [Jujutsu (jj) version control system](https://github.com/jj-vcs/jj).

[![VS Code Extension](https://img.shields.io/visual-studio-marketplace/v/jjk.jjk)](https://marketplace.visualstudio.com/items?itemName=jjk.jjk)
[![Discord](https://img.shields.io/discord/968932220549103686?color=5865F2&label=Discord&logo=discord&logoColor=white)](https://discord.gg/BqBjUVerfq)

## 🚀 Features

The goal of this extension is to bring the great UX of Jujutsu into the VS Code UI. We are currently focused on achieving parity for commonly used features of VS Code's built-in Git extension, such as the various operations possible via the Source Control view.

Here's what you can do so far:

### 📁 File Management

- Track file statuses in the Working Copy
- Monitor file statuses across all parent changes
- View detailed file diffs for Working Copy and parent modifications  
  ![view file diff](images/diff.png)
- View line-by-line blame  
  <img src="images/blame.gif" width="70%" alt="view blame">

### 💫 Change Management

- Create new changes with optional descriptions
- Edit descriptions for Working Copy and parent changes  
  ![edit description](images/describe.png)
- Move changes between Working Copy and parents  
  ![squash](images/squash.png)
- Move specific lines from the Working Copy to its parent changes
  ![squash range](images/squash_range.webp)
- Discard changes  
  ![restore](images/restore.png)
- Browse and navigate revision history  
  <img src="images/edit.gif" width="50%" alt="revision history">
- Create merge changes  
  <img src="images/merge.gif" width="50%" alt="revision history">

### 🔄 Operation Management

- Undo jj operations or restore to a previous state  
  <img src="images/undo.gif" width="50%" alt="undo">

## 📋 Prerequisites

- Ensure `jj` is installed and available in your system's `$PATH`, or configure a custom path using the `jjk.jjPath` setting

## 🐛 Known Issues

If you encounter any problems, please [report them on GitHub](https://github.com/keanemind/jjk/issues/)!

## 📝 License

This project is licensed under the [MIT License](LICENSE).
