package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	// Set up channel to receive os.Interrupt signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Print the PID of the process
	fmt.Println(os.Getpid())

	// Print command line arguments
	for _, arg := range os.Args {
		fmt.Println(arg)
	}

	// Use select to handle the interrupt signal
	select {
	case <-time.After(10 * time.Second):
		os.Exit(1)
	case <-sigChan:
		os.Exit(0)
	}
}
