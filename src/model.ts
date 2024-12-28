import * as vscode from 'vscode';

const jjSCM = vscode.scm.createSourceControl('jj', 'Jujutsu');

const workingCopy = jjSCM.createResourceGroup('workingCopy', 'Working Copy');

// Fetch resource states for the working copy (change and commit IDs, files changed)

// export function fetchResourceStates() {
//   // Interface with jj CLI to get the status of the working copy
//   // and populate the workingCopy resource group with the corresponding info
// }
